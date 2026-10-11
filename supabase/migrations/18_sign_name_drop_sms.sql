-- 2.12.0 (part 3): sign with a name, one payment for one person ever, nothing older than an hour, and the
-- SMS-forwarding idea is dropped.
--
-- 1. book_slot() now needs the name the client signed with ("p_proof"->>'signed_name'): their first and
--    last name as it shows when money is received. The owner sees it next to the screenshot and matches
--    it to the message on his phone, so each person claims their own payment.
-- 2. A screenshot or transaction ID that has backed a booking can't back another one, even after that
--    booking is cancelled (so two people can't use one payment). Only a payment the owner marked
--    "Not received" is free again. proof_in_use() lets the page say so as soon as a screenshot is picked.
-- 3. The screenshot and the payment on it can't be more than an hour old.
-- 4. The automatic checking from the owner's SMS (migration 17) is removed: his phone can't forward
--    messages. Its tables and functions go, and get_pay_info() and the others return to their
--    migration 16 form.
--
-- Run once in the Supabase SQL editor, after 17_sms_verification.sql.

-- One payment, one booking, for good (the owner's "Not received" is the only way back).
drop index if exists public.bookings_payment_ref_used;
create unique index bookings_payment_ref_used
  on public.bookings (lower(payment_ref))
  where payment_ref is not null and payment_status <> 'rejected';
drop index if exists public.bookings_proof_hash_used;
create unique index bookings_proof_hash_used
  on public.bookings (payment_proof_hash)
  where payment_proof_hash is not null and payment_status <> 'rejected';

-- Has this screenshot (its fingerprint) or this transaction ID already been used? Says nothing else.
create or replace function public.proof_in_use(p_hash text, p_txn text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.bookings
    where payment_status <> 'rejected'
      and ((lower(coalesce(p_hash, '')) ~ '^[0-9a-f]{64}$' and payment_proof_hash = lower(p_hash))
        or (length(btrim(coalesce(p_txn, ''))) >= 5 and lower(payment_ref) = lower(btrim(p_txn))))
  );
$$;
grant execute on function public.proof_in_use(text, text) to anon, authenticated;

-- The functions that mention the SMS tables first, so nothing points at them when they go.
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
  v_path text;
  v_hash text;
  v_start int;
begin
  select * into c from public.site_config where id = 1;
  v_pay := c.require_payment
    and coalesce(btrim((select instructions from public.payment_config where id = 1)), '') <> '';

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

  if v_pay then
    if p_proof is null or jsonb_typeof(p_proof) <> 'object' then
      raise exception 'Please pay first, then upload a screenshot of your payment.';
    end if;
    if pg_column_size(p_proof) > 30000 then
      raise exception 'That payment screenshot could not be accepted. Please call the shop.';
    end if;
    -- The client signs with their name as it shows when money is received, so the owner can match the
    -- payment to the right person (the name he sees on his phone when the money arrives).
    if coalesce(btrim(p_proof->>'signed_name'), '') !~ '^[A-Za-z][A-Za-z.''-]*( +[A-Za-z][A-Za-z.''-]*)+$'
       or length(btrim(p_proof->>'signed_name')) < 5 or length(btrim(p_proof->>'signed_name')) > 60 then
      raise exception 'Please sign with your name exactly as it shows when money is received (first and last name).';
    end if;
    -- The screenshot, and the payment on it, can't be more than an hour old (the page checks this too).
    if p_proof->'file'->>'modified' ~ '^\d{4}-\d{2}-\d{2}T' and now() - (p_proof->'file'->>'modified')::timestamptz > interval '65 minutes' then
      raise exception 'That screenshot is more than an hour old. Please pay again and send a screenshot of the new payment.';
    end if;
    if p_proof->'extracted'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' and p_proof->'extracted'->>'pay_time' ~ '^\d{2}:\d{2}$'
       and public.shop_now() - ((p_proof->'extracted'->>'date')::date + (p_proof->'extracted'->>'pay_time')::time) > interval '70 minutes' then
      raise exception 'That payment is more than an hour old. Please pay again and send a screenshot of the new payment.';
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
    select 1 from public.bookings where lower(payment_ref) = lower(v_ref) and payment_status <> 'rejected'
  ) then
    raise exception 'That payment (transaction ID) has already been used for a booking. Each payment is for one booking.';
  end if;
  if v_pay and exists (
    select 1 from public.bookings where payment_proof_hash = v_hash and payment_status <> 'rejected'
  ) then
    raise exception 'That screenshot has already been used for a booking. Each payment is for one booking.';
  end if;

  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token,
                               payment_status, payment_ref, payment_submitted_at,
                               payment_proof, payment_proof_path, payment_proof_hash)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), v_device,
          case when v_pay then 'submitted' else 'none' end,
          case when v_pay then v_ref end,
          case when v_pay then now() end,
          case when v_pay then p_proof end,
          case when v_pay then v_path end,
          case when v_pay then v_hash end)
  returning client_token into v_token;
  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken. Please pick another.';
end;
$$;
grant execute on function public.book_slot(date, time, text, text, text, text, text, jsonb) to anon, authenticated;

drop function if exists public.get_pay_info();
create or replace function public.get_pay_info()
returns table (required boolean, instructions text, amount_kwacha numeric)
language sql stable security definer set search_path = public as $$
  select
    (c.require_payment and btrim(p.instructions) <> ''),
    case when c.require_payment and btrim(p.instructions) <> '' then p.instructions end,
    c.price_kwacha
  from public.site_config c, public.payment_config p
  where c.id = 1 and p.id = 1;
$$;
grant execute on function public.get_pay_info() to anon, authenticated;

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
      if new.payment_status = 'submitted' then
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

-- ============================================================ REMOVING THE SMS CHECKING
drop trigger if exists release_sms_claim on public.bookings;
drop function if exists public.release_sms_claim();
drop function if exists public.record_received_sms(text, text, text);
drop function if exists public.check_payment(text);
drop function if exists public.parse_money_sms(text);
drop function if exists public.admin_sms_status();
drop function if exists public.admin_new_sms_secret();
drop function if exists public.admin_set_sms_auto(boolean);
drop function if exists public.admin_list_sms(int);
drop table if exists public.sms_inbox;
drop table if exists public.sms_settings;
alter table public.bookings drop column if exists payment_auto;

select 'migration 18 applied' as result;
