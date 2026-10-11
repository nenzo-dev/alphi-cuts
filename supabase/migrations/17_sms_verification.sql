-- 2.12.0 (part 2): payments checked automatically against the owner's own "money received" messages.
--
-- The owner's phone forwards each mobile-money SMS it receives to record_received_sms() (with a secret
-- the owner makes in the panel). Messages from mobile-money and bank senders are read here (amount,
-- transaction ID, who sent it) and kept in sms_inbox; all others are dropped. When "check payments
-- automatically" is on, a client pays, types the transaction ID from their own message (or reads it
-- from a screenshot), and book_slot() finds that payment among the received messages: big enough,
-- recent, not spent on another booking. The booking is then paid straight away. A made-up transaction
-- ID can't match. If the owner's phone is off, nothing arrives and nobody can book; the owner turns the
-- switch off (the screenshot way from migration 16 takes over) or books people in by hand.
--
-- Run once in the Supabase SQL editor, after 16_payment_screenshots.sql.

alter table public.bookings add column if not exists payment_auto boolean not null default false;  -- paid and found in the owner's messages

-- ============================================================ SETTINGS AND THE MESSAGES
create table if not exists public.sms_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  secret_hash text,                 -- SHA-256 of the secret; the secret itself is shown once, when it is made
  last_seen_at timestamptz,         -- the last time the phone called with the right secret
  updated_at timestamptz not null default now()
);
insert into public.sms_settings (id) values (1) on conflict (id) do nothing;
alter table public.sms_settings enable row level security;
drop policy if exists sms_settings_owner_all on public.sms_settings;
create policy sms_settings_owner_all on public.sms_settings for all using (public.is_owner()) with check (public.is_owner());

create table if not exists public.sms_inbox (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  sender text,
  body text not null,
  kind text not null check (kind in ('payment', 'ignored', 'unreadable')),
    -- payment: money received, amount and transaction ID read. ignored: some other message from a money
    -- sender (money sent, airtime ...). unreadable: looks like money received but no amount or ID found.
  amount numeric(10, 2),
  txn_id text,
  from_name text,
  from_phone text,
  claimed_by uuid references public.bookings(id) on delete set null,   -- the booking this payment paid for
  claimed_at timestamptz
);
create unique index if not exists sms_inbox_txn on public.sms_inbox (lower(txn_id)) where kind = 'payment' and txn_id is not null;
create index if not exists sms_inbox_received on public.sms_inbox (received_at desc);
alter table public.sms_inbox enable row level security;
drop policy if exists sms_inbox_owner_all on public.sms_inbox;
create policy sms_inbox_owner_all on public.sms_inbox for all using (public.is_owner()) with check (public.is_owner());

-- ============================================================ READING A MESSAGE
-- Formats differ between networks and change over time, so this is forgiving, and every message
-- is kept so it can be read again if a format turns out different.
create or replace function public.parse_money_sms(p_text text)
returns table (incoming boolean, amount numeric, txn_id text, from_name text, from_phone text)
language plpgsql immutable as $$
declare
  t text := regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g');
  t2 text;
  a text;
begin
  incoming := t ~* '(received|credited|you were paid|payment from|money from|deposit|sent you|sent to you)'
    and t !~* '(you have sent|you sent|you have paid|you paid|paid to|withdraw|cash ?out|airtime|bundle|purchase)';

  -- the amount: the first money figure once balances and fees are taken out
  t2 := regexp_replace(t, '(new |available |current |your )?(balance|bal|fee|fees|charge|charges)[^0-9]{0,14}(ZMW|ZMK|K)?\s?[0-9][0-9,]*(\.[0-9]{1,2})?', ' ', 'gi');
  a := substring(t2 from '(?i)(?:ZMW|ZMK|KWACHA|\mK)\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)');
  amount := case when a is null then null else replace(a, ',', '')::numeric end;

  txn_id := substring(t from '(?i)(?:financial\s+transaction\s+id|trans(?:action)?\.?\s*id|txn\.?\s*id|trx\.?\s*id|\mtid|ref(?:erence)?(?:\s*(?:no|id|number))?\.?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9._-]{5,34})');
  if txn_id is null then
    txn_id := substring(t from '\m([A-Z]{2}[0-9]{6}\.[0-9]{4}\.[A-Z0-9]{4,8})\M');
  end if;
  txn_id := regexp_replace(txn_id, '[._-]+$', '');
  if txn_id is not null and length(regexp_replace(txn_id, '[^0-9]', '', 'g')) < 4 then txn_id := null; end if;

  from_phone := substring(t from '((?:\+?260|\m0)[0-9]{9})');
  from_name := nullif(btrim(substring(t from '(?i)from\s+([A-Za-z][A-Za-z .''-]{1,40}?)\s*(?:[0-9(]|\.|,|$|\s(?:on|trans|txn|ref|financial))')), '');
  return next;
end;
$$;

-- What the owner's phone calls (the secret proves it is the phone). Messages from mobile-money and
-- bank senders are read and kept; anything else is dropped. Calling it twice with the same message is harmless.
create or replace function public.record_received_sms(p_secret text, p_from text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.sms_settings;
  r record;
  v_kind text;
  v_from text := left(btrim(coalesce(p_from, '')), 40);
  v_body text := left(btrim(coalesce(p_text, '')), 1000);
begin
  select * into s from public.sms_settings where id = 1;
  if s.secret_hash is null or encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex') <> s.secret_hash then
    raise exception 'Not allowed.';
  end if;
  update public.sms_settings set last_seen_at = now() where id = 1;

  if v_body = '' or v_from !~* '(airtel|mtn|momo|zamtel|kwacha|zanaco|stanbic|fnb|absa|ecobank|access ?bank|atlas|indo ?zambia|first ?alliance|bank)' then
    return jsonb_build_object('ok', true, 'stored', false, 'reason', 'not a mobile money or bank sender');
  end if;

  select * into r from public.parse_money_sms(v_body);
  v_kind := case
    when not r.incoming then 'ignored'
    when r.amount is null or r.txn_id is null then 'unreadable'
    else 'payment' end;
  insert into public.sms_inbox (sender, body, kind, amount, txn_id, from_name, from_phone)
  values (v_from, v_body, v_kind,
          case when v_kind = 'payment' then r.amount end,
          case when v_kind = 'payment' then r.txn_id end,
          r.from_name, r.from_phone)
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'stored', true, 'kind', v_kind, 'amount', r.amount, 'txn_id', r.txn_id);
end;
$$;
grant execute on function public.record_received_sms(text, text, text) to anon, authenticated;

-- ============================================================ WHAT A CLIENT CAN ASK
-- Has this payment arrived? none (not yet), low (too little), used (spent on a booking) or ok.
-- Says nothing else about it.
create or replace function public.check_payment(p_txn text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v text := btrim(coalesce(p_txn, ''));
  r public.sms_inbox;
  v_price numeric;
begin
  if length(v) < 5 or length(v) > 40 then return 'none'; end if;
  select price_kwacha into v_price from public.site_config where id = 1;
  select * into r from public.sms_inbox
    where kind = 'payment' and lower(txn_id) = lower(v) and received_at > now() - interval '3 days';
  if not found then return 'none'; end if;
  if r.claimed_by is not null then return 'used'; end if;
  if r.amount + 0.001 < v_price then return 'low'; end if;
  return 'ok';
end;
$$;
grant execute on function public.check_payment(text) to anon, authenticated;

-- A cancelled booking gives its payment back, so it can pay for another one.
create or replace function public.release_sms_claim()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.sms_inbox set claimed_by = null, claimed_at = null where claimed_by = new.id;
  return new;
end;
$$;
revoke all on function public.release_sms_claim() from public, anon, authenticated;
drop trigger if exists release_sms_claim on public.bookings;
create trigger release_sms_claim after update of status on public.bookings
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.release_sms_claim();

-- Whether clients are checked automatically: this is what the booking form asks (it replaces the
-- version from migration 15, with one more answer).
drop function if exists public.get_pay_info();
create or replace function public.get_pay_info()
returns table (required boolean, instructions text, amount_kwacha numeric, auto boolean)
language sql stable security definer set search_path = public as $$
  select
    (c.require_payment and btrim(p.instructions) <> ''),
    case when c.require_payment and btrim(p.instructions) <> '' then p.instructions end,
    c.price_kwacha,
    (c.require_payment and btrim(p.instructions) <> ''
       and coalesce((select s.enabled and s.secret_hash is not null from public.sms_settings s where s.id = 1), false))
  from public.site_config c, public.payment_config p
  where c.id = 1 and p.id = 1;
$$;
grant execute on function public.get_pay_info() to anon, authenticated;

-- ============================================================ OWNER PANEL
create or replace function public.admin_sms_status()
returns table (enabled boolean, has_secret boolean, last_seen_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.enabled, s.secret_hash is not null, s.last_seen_at from public.sms_settings s where s.id = 1 and public.is_owner();
$$;
revoke all on function public.admin_sms_status() from public, anon;
grant execute on function public.admin_sms_status() to authenticated;

-- Makes a new secret (the old one stops working) and answers it. Only the hash is kept, so it is shown once.
create or replace function public.admin_new_sms_secret()
returns text language plpgsql security definer set search_path = public as $$
declare v_secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.sms_settings
    set secret_hash = encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), updated_at = now()
    where id = 1;
  return v_secret;
end;
$$;
revoke all on function public.admin_new_sms_secret() from public, anon;
grant execute on function public.admin_new_sms_secret() to authenticated;

create or replace function public.admin_set_sms_auto(p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if coalesce(p_on, false) and (select secret_hash is null from public.sms_settings where id = 1) then
    raise exception 'Make your secret first, and set up your phone to send the messages.';
  end if;
  update public.sms_settings set enabled = coalesce(p_on, false), updated_at = now() where id = 1;
end;
$$;
revoke all on function public.admin_set_sms_auto(boolean) from public, anon;
grant execute on function public.admin_set_sms_auto(boolean) to authenticated;

create or replace function public.admin_list_sms(p_limit int default 30)
returns table (id uuid, received_at timestamptz, sender text, body text, kind text, amount numeric,
               txn_id text, from_name text, from_phone text, claimed_by uuid, claimed_name text)
language sql stable security definer set search_path = public as $$
  select m.id, m.received_at, m.sender, m.body, m.kind, m.amount, m.txn_id, m.from_name, m.from_phone,
         m.claimed_by, b.client_name
  from public.sms_inbox m left join public.bookings b on b.id = m.claimed_by
  where public.is_owner()
  order by m.received_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
revoke all on function public.admin_list_sms(int) from public, anon;
grant execute on function public.admin_list_sms(int) to authenticated;

-- ============================================================ BOOKING, NOTIFICATION, CLEANUP
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null, p_device text default null,
  p_pay_ref text default null, p_proof jsonb default null
) returns text   -- the new booking's client_token
language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_token text;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_device text := case when public.valid_token(p_device) then p_device end;
  v_ref text := btrim(coalesce(p_pay_ref, ''));
  v_pay boolean;   -- payment is needed before this booking
  v_auto boolean;  -- ... and it is checked against the owner's received-money messages
  v_sms public.sms_inbox;
  v_id uuid;
  v_path text;
  v_hash text;
  v_start int;
begin
  select * into c from public.site_config where id = 1;
  v_pay := c.require_payment
    and coalesce(btrim((select instructions from public.payment_config where id = 1)), '') <> '';
  v_auto := v_pay and exists (select 1 from public.sms_settings where id = 1 and enabled and secret_hash is not null);

  if coalesce(c.content->'hidden', '[]'::jsonb) ? 'book' then
    raise exception 'Online booking is paused right now. Please call or visit the shop.';
  end if;
  if p_date is null or p_slot is null then
    raise exception 'Please pick a day and a time.';
  end if;
  v_start := public.minute_of(p_slot);
  if p_date < public.shop_today() then
    raise exception 'That date has already passed.';
  end if;
  if p_date > public.shop_today() + (c.booking_days_ahead - 1) then
    raise exception 'You can only book up to % days ahead.', c.booking_days_ahead;
  end if;
  if extract(dow from p_date)::int = any(c.closed_weekdays) then
    raise exception 'The shop is closed that day.';
  end if;
  if v_start < public.minute_of(c.open_time) or v_start + c.slot_minutes > public.minute_of(c.close_time) then
    raise exception 'That time is outside opening hours.';
  end if;
  if (v_start - public.minute_of(c.open_time)) % c.slot_minutes <> 0 then
    raise exception 'Please pick one of the listed times.';
  end if;
  if p_date = public.shop_today() and p_slot <= public.shop_now()::time then
    raise exception 'That time has already passed. Please pick a later one.';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Please enter your name (up to 60 characters).';
  end if;
  if length(v_digits) < 9 or length(v_digits) > 15 or length(v_phone) > 20 then
    raise exception 'Please enter a valid phone number.';
  end if;
  if length(coalesce(p_style, '')) > 100 then
    raise exception 'That style name is too long.';
  end if;

  if v_auto then
    if length(v_ref) < 5 or length(v_ref) > 40 or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._/:#-]*$' then
      raise exception 'Please enter the transaction ID from your payment message.';
    end if;
  elsif v_pay then
    if p_proof is null or jsonb_typeof(p_proof) <> 'object' then
      raise exception 'Please pay first, then upload a screenshot of your payment.';
    end if;
    if pg_column_size(p_proof) > 30000 then
      raise exception 'That payment screenshot could not be accepted. Please call the shop.';
    end if;
    v_path := p_proof->>'path';
    v_hash := lower(coalesce(p_proof->>'sha256', ''));
    if p_proof->>'verdict' is distinct from 'approved'
       or v_hash !~ '^[0-9a-f]{64}$'
       or length(v_ref) < 5 or length(v_ref) > 40 or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._/:#-]*$'
       or lower(coalesce(p_proof->'extracted'->>'txn_id', '')) <> lower(v_ref)
       or coalesce(nullif(p_proof->'extracted'->>'amount', '')::numeric, 0) + 0.001 < c.price_kwacha then
      raise exception 'That payment screenshot was not accepted. If you really paid, please call the shop to confirm.';
    end if;
    if v_path is null or not public.valid_token(split_part(v_path, '/', 1))
       or not exists (select 1 from storage.objects where bucket_id = 'payment-proofs' and name = v_path) then
      raise exception 'Your screenshot did not upload. Please try again.';
    end if;
  end if;

  -- Bookings go through one at a time, so one person can't take two slots by booking twice at once,
  -- and two people can't take overlapping slots (walk-ins take the same lock for the day).
  perform pg_advisory_xact_lock(hashtext('book_slot'));
  perform pg_advisory_xact_lock(hashtext('book_slot:' || p_date::text));

  -- One booking at a time: the same phone number, or the same device, can't hold two.
  if exists (
    select 1 from public.bookings
    where booking_date >= public.shop_today()
      and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
      and right(regexp_replace(client_phone, '\D', '', 'g'), 9) = right(v_digits, 9)
  ) then
    raise exception 'This phone number already has a booking. You can only book one slot at a time.';
  end if;
  if v_device is not null and exists (
    select 1 from public.bookings
    where booking_date >= public.shop_today()
      and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
      and device_token = v_device
  ) then
    raise exception 'You already have a booking. You can only book one slot at a time, so cancel it first to pick another time.';
  end if;

  -- One payment, one booking: the same transaction ID or the same screenshot can't be used twice.
  if v_pay and exists (
    select 1 from public.bookings where lower(payment_ref) = lower(v_ref) and status <> 'cancelled'
  ) then
    raise exception 'That payment (transaction ID) has already been used for a booking. Each payment is for one booking.';
  end if;
  if v_pay and not v_auto and exists (
    select 1 from public.bookings where payment_proof_hash = v_hash and status <> 'cancelled'
  ) then
    raise exception 'That screenshot has already been used for a booking. Each payment is for one booking.';
  end if;

  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  -- Checked automatically: the payment has to be in the owner's received-money messages, big enough,
  -- and not already spent on another booking.
  if v_auto then
    select * into v_sms from public.sms_inbox
      where kind = 'payment' and lower(txn_id) = lower(v_ref) and received_at > now() - interval '3 days'
      for update;
    if not found then
      raise exception 'We have not received that payment yet. It can take a minute after you pay. Check the transaction ID and try again.';
    end if;
    if v_sms.claimed_by is not null then
      raise exception 'That payment has already been used for a booking. Each payment is for one booking.';
    end if;
    if v_sms.amount + 0.001 < c.price_kwacha then
      raise exception 'That payment is K%, but the price is K%.', v_sms.amount::numeric(10, 2), c.price_kwacha::numeric(10, 2);
    end if;
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token,
                               payment_status, payment_ref, payment_submitted_at, paid_at, payment_auto,
                               payment_proof, payment_proof_path, payment_proof_hash)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), v_device,
          case when v_auto then 'paid' when v_pay then 'submitted' else 'none' end,
          case when v_pay then v_ref end,
          case when v_pay then now() end,
          case when v_auto then now() end,
          v_auto,
          case when v_pay and not v_auto then p_proof end,
          case when v_pay and not v_auto then v_path end,
          case when v_pay and not v_auto then v_hash end)
  returning client_token, id into v_token, v_id;
  if v_auto then
    update public.sms_inbox set claimed_by = v_id, claimed_at = now() where id = v_sms.id;
  end if;
  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken. Please pick another.';
end;
$$;
grant execute on function public.book_slot(date, time, text, text, text, text, text, jsonb) to anon, authenticated;

create or replace function public.push_on_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner boolean := public.is_owner();
  v_shop text;
  v_when text;
begin
  select btrim(shop_name) into v_shop from public.site_config where id = 1;

  if tg_op = 'DELETE' then
    if old.status not in ('booked', 'on_deck', 'called', 'checked_in') or old.booking_date < public.shop_today() then return old; end if;
    v_when := public.push_time(old.slot_time) || ' ' || public.push_day(old.booking_date);
    if v_owner then
      perform public.push_queue('booking', old.client_token, 'Booking cancelled',
        'Your booking for ' || v_when || ' at ' || v_shop || ' was cancelled by the shop. You can book another slot any time.',
        './#book', 'booking-' || old.client_token, false, 'cancel:' || old.id);
    else
      perform public.push_queue('owners', 'owners', 'Booking cancelled',
        old.client_name || ' cancelled their booking for ' || v_when || '.', './admin#bookings', 'owner-booking', false, 'cancel:' || old.id);
    end if;
    return old;
  end if;

  v_when := public.push_time(new.slot_time) || ' ' || public.push_day(new.booking_date);

  if tg_op = 'INSERT' then
    if not v_owner then
      if new.payment_auto then
        perform public.push_queue('owners', 'owners', 'New booking, paid',
          new.client_name || ', ' || v_when || '. Payment ' || new.payment_ref || ' found in your messages and checked automatically.',
          './admin#bookings', 'owner-booking', false, 'new:' || new.id);
      elsif new.payment_status = 'submitted' then
        perform public.push_queue('owners', 'owners', 'New booking: check the payment',
          new.client_name || ', ' || v_when || '. Transaction ' || new.payment_ref || '. Open Payments to see the screenshot.',
          './admin#payments', 'owner-booking', false, 'new:' || new.id);
      else
        perform public.push_queue('owners', 'owners', 'New booking',
          new.client_name || ', ' || v_when || coalesce(' (' || nullif(btrim(new.style_choice), '') || ')', '') || '.',
          './admin#bookings', 'owner-booking', false, 'new:' || new.id);
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.status is distinct from old.status then
    if new.status = 'on_deck' then
      perform public.push_queue('booking', new.client_token, 'Almost your turn',
        public.push_text('alert_on_deck', 'You''re 2 away at {shop}. Start heading over.', new.slot_time),
        './#book', 'booking-' || new.client_token, false, 'on_deck:' || new.id);
    elsif new.status = 'called' then
      perform public.push_queue('booking', new.client_token, 'You''re next',
        public.push_text('alert_called', 'You''re next at {shop}. Please be at the shop now.', new.slot_time),
        './#book', 'booking-' || new.client_token, true, 'called:' || new.id);
    elsif new.status = 'checked_in' then
      if new.arrived_auto then
        perform public.push_queue('booking', new.client_token, v_shop,
          public.push_text('alert_arrived', 'You''re checked in at {shop}. {owner_first} can see you''re here.', new.slot_time),
          './#book', 'arrived', false, 'arrived:' || new.id);
      end if;
      if not v_owner then
        perform public.push_queue('owners', 'owners', 'Client here',
          new.client_name || ' is here for ' || public.push_time(new.slot_time) || '.', './admin#queue', 'owner-here', false, 'here:' || new.id);
      end if;
    elsif new.status = 'cancelled' then
      if new.payment_status = 'rejected' then
        perform public.push_queue('booking', new.client_token, 'Payment not found',
          public.push_text('pay_not_found', '{owner_first} could not find your payment for {time}, so the booking was cancelled. If you did pay, message {owner_first} with your payment reference.', new.slot_time),
          './#book', 'pay-' || new.client_token, false, 'payno:' || new.id);
      elsif new.payment_expired_at is not null and new.payment_expired_at is distinct from old.payment_expired_at then
        null;   -- cleared at the slot time: expire_payment_requests() tells the client
      elsif v_owner then
        perform public.push_queue('booking', new.client_token, 'Booking cancelled',
          'Your booking for ' || v_when || ' at ' || v_shop || ' was cancelled by the shop.',
          './#book', 'booking-' || new.client_token, false, 'cancel:' || new.id);
      else
        perform public.push_queue('owners', 'owners', 'Booking cancelled',
          new.client_name || ' cancelled their booking for ' || v_when || '.', './admin#bookings', 'owner-booking', false, 'cancel:' || new.id);
      end if;
    end if;
  end if;

  if new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'requested' then
      perform public.push_queue('owners', 'owners', 'Online payment request',
        new.client_name || ' would like to pay online for ' || v_when || '.', './admin#payments', 'owner-payment', false, 'payreq:' || new.id);
    elsif new.payment_status = 'approved' then
      perform public.push_queue('booking', new.client_token, 'You can pay online',
        'Your online payment for ' || v_when || ' is approved. Open your booking to see how to pay.',
        './#book', 'pay-' || new.client_token, false, 'payok:' || new.id);
    elsif new.payment_status = 'paid' and old.payment_status = 'submitted' then
      perform public.push_queue('booking', new.client_token, 'Payment received',
        'Your payment for ' || v_when || ' at ' || v_shop || ' is confirmed. See you then.',
        './#book', 'pay-' || new.client_token, false, 'paid:' || new.id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.push_on_booking() from public, anon, authenticated;

create or replace function public.cleanup_old_records()
returns void language plpgsql security definer set search_path = public as $$
declare v_keep int;
begin
  select keep_days into v_keep from public.site_config where id = 1;
  v_keep := greatest(coalesce(v_keep, 90), 7);
  delete from public.bookings
    where status = 'cancelled' and payment_status not in ('approved', 'submitted', 'paid');
  delete from public.bookings
    where status = 'no_show' and booking_date < public.shop_today() and payment_status not in ('approved', 'submitted', 'paid');
  delete from public.bookings where booking_date < public.shop_today() - v_keep;
  delete from public.chat_messages where created_at < now() - make_interval(days => v_keep);
  delete from public.sms_inbox where received_at < now() - make_interval(days => v_keep);
  delete from public.style_requests
    where storage_path is null and created_at < now() - make_interval(days => v_keep);
  delete from public.push_outbox where created_at < now() - interval '2 days';
  delete from public.push_subscriptions where owner_id is null and updated_at < now() - make_interval(days => v_keep);
  update public.push_subscriptions s
    set booking_tokens = coalesce(array(select t from unnest(s.booking_tokens) t
                                        where exists (select 1 from public.bookings b where b.client_token = t)), '{}')
    where s.booking_tokens <> '{}';
end;
$$;
revoke execute on function public.cleanup_old_records() from public, anon, authenticated;

select 'migration 17 applied' as result;
