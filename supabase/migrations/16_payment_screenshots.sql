-- 2.12.0: pay first with a screenshot of the payment, and walk-ins come last.
--
-- 1. While pay-before-booking is on, book_slot() needs a screenshot of the payment. The page reads
--    it on the client's phone (who was paid, how much, transaction ID, date, the file's own details)
--    and only offers the times when it checks out. The screenshot goes to a private bucket
--    ("payment-proofs") and what was read is saved with the booking, so the owner can look at the
--    picture next to it before tapping Mark paid. The database checks what it can: the proof says
--    approved, the picture is really in the bucket, the amount covers the price, the transaction
--    ID matches, and one screenshot (by fingerprint) or one transaction ID backs one booking. It
--    can't read the picture itself, so the owner's confirmation is still what counts.
-- 2. Walk-ins come last: they are marked (bookings.is_walkin), and the automatic start never puts a
--    walk-in in the chair ahead of a booked client, or when a booked client's slot is about to start.
-- 3. The owner can book a client in by hand (admin_add_booking), for someone whose screenshot was
--    turned down but who has shown the payment.
-- 4. admin_stale_payment_proofs() lists screenshots nothing refers to any more, for the owner panel
--    to delete (files can't be deleted from SQL).
--
-- Run once in the Supabase SQL editor, after 15_pay_first.sql.

-- ============================================================ COLUMNS
alter table public.bookings add column if not exists payment_proof jsonb;        -- what was read from the screenshot
alter table public.bookings add column if not exists payment_proof_path text;    -- the picture, in the payment-proofs bucket
alter table public.bookings add column if not exists payment_proof_hash text;    -- SHA-256 of the picture
alter table public.bookings add column if not exists is_walkin boolean not null default false;

update public.bookings set is_walkin = true where client_phone = 'walk-in' and not is_walkin;

create unique index if not exists bookings_proof_hash_used
  on public.bookings (payment_proof_hash)
  where payment_proof_hash is not null and status <> 'cancelled';

-- ============================================================ STORAGE
-- Private. Anyone can upload one picture (5-8 MB at most) into a folder named after their device's
-- random token; only the owner can read or delete them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 8388608, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists payment_proofs_bucket_write on storage.objects;
create policy payment_proofs_bucket_write on storage.objects for insert
  with check (bucket_id = 'payment-proofs' and public.valid_token(split_part(name, '/', 1)));
drop policy if exists payment_proofs_bucket_read on storage.objects;
create policy payment_proofs_bucket_read on storage.objects for select
  using (bucket_id = 'payment-proofs' and public.is_owner());
drop policy if exists payment_proofs_bucket_delete on storage.objects;
create policy payment_proofs_bucket_delete on storage.objects for delete
  using (bucket_id = 'payment-proofs' and public.is_owner());

-- ============================================================ BOOKING: THE SCREENSHOT
drop function if exists public.book_slot(date, time, text, text, text, text, text);
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
  if v_pay and exists (
    select 1 from public.bookings where payment_proof_hash = v_hash and status <> 'cancelled'
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

-- ============================================================ WALK-INS COME LAST
-- A walk-in gets the earliest free slot that hasn't finished yet, and is marked as a walk-in.
create or replace function public.admin_add_walkin(p_name text, p_phone text)
returns time language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_today date := public.shop_today();
  v_now int := public.minute_of(public.shop_now()::time);
  v_name text := btrim(coalesce(p_name, ''));
  v_t int;
  v_slot time;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Enter the walk-in''s name (up to 60 characters).';
  end if;
  select * into c from public.site_config where id = 1;
  perform pg_advisory_xact_lock(hashtext('book_slot:' || v_today::text));

  v_t := public.minute_of(c.open_time);
  while v_t + c.slot_minutes <= public.minute_of(c.close_time) loop
    if v_t + c.slot_minutes > v_now then
      v_slot := make_time(v_t / 60, v_t % 60, 0);
      if not public.slot_is_taken(v_today, v_slot, c.slot_minutes) then
        insert into public.bookings (booking_date, slot_time, client_name, client_phone, status, checked_in_at, is_walkin)
        values (v_today, v_slot, v_name, coalesce(nullif(btrim(p_phone), ''), 'walk-in'), 'checked_in', now(), true);
        return v_slot;
      end if;
    end if;
    v_t := v_t + c.slot_minutes;
  end loop;
  raise exception 'There are no free slots left today.';
end;
$$;
grant execute on function public.admin_add_walkin(text, text) to authenticated;

-- Every minute: the next checked-in client whose slot has started goes into the chair, if the chair is
-- free (or a cut has run for more than two slots). Booked clients first, in slot order; a walk-in
-- only when no booked client is waiting or about to be, and an unconfirmed payment never.
create or replace function public.auto_start_due()
returns int language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_today date := public.shop_today();
  v_now int := public.minute_of(public.shop_now()::time);
  v_next uuid;
  v_walkin boolean;
  v_busy_since timestamptz;
begin
  select * into c from public.site_config where id = 1;
  if not c.auto_start then return 0; end if;
  select id, is_walkin into v_next, v_walkin from public.bookings
    where booking_date = v_today and status = 'checked_in' and public.minute_of(slot_time) <= v_now
      and payment_status <> 'submitted'
    order by is_walkin, slot_time limit 1;
  if v_next is null then return 0; end if;
  if v_walkin and exists (
    select 1 from public.bookings
    where booking_date = v_today and not is_walkin
      and status in ('booked', 'on_deck', 'called', 'checked_in')
      and public.minute_of(slot_time) < v_now + c.slot_minutes
  ) then
    return 0;   -- a booked client comes first
  end if;
  select max(started_at) into v_busy_since from public.bookings where booking_date = v_today and status = 'in_chair';
  if v_busy_since is not null and v_busy_since > now() - make_interval(mins => 2 * c.slot_minutes) then return 0; end if;
  if public.start_cut_internal(v_next) then return 1; end if;
  return 0;
end;
$$;
revoke all on function public.auto_start_due() from public, anon, authenticated;

-- ============================================================ OWNER BOOKS A CLIENT IN
-- For someone whose screenshot was turned down but who has shown the owner the payment. Same
-- rules for the day and the slot as a client booking; counted as paid.
create or replace function public.admin_add_booking(p_date date, p_slot time, p_name text, p_phone text, p_style text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_start int;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select * into c from public.site_config where id = 1;
  if p_date is null or p_slot is null then raise exception 'Pick a day and a time.'; end if;
  v_start := public.minute_of(p_slot);
  if p_date < public.shop_today() then raise exception 'That date has already passed.'; end if;
  if p_date > public.shop_today() + (c.booking_days_ahead - 1) then
    raise exception 'That is further ahead than clients can book (% days).', c.booking_days_ahead;
  end if;
  if extract(dow from p_date)::int = any(c.closed_weekdays) then raise exception 'The shop is closed that day.'; end if;
  if v_start < public.minute_of(c.open_time) or v_start + c.slot_minutes > public.minute_of(c.close_time)
     or (v_start - public.minute_of(c.open_time)) % c.slot_minutes <> 0 then
    raise exception 'Pick one of the listed times.';
  end if;
  if p_date = public.shop_today() and p_slot <= public.shop_now()::time then
    raise exception 'That time has already passed. Pick a later one.';
  end if;
  if v_name = '' or length(v_name) > 60 then raise exception 'Enter the name (up to 60 characters).'; end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 9 or length(v_phone) > 20 then
    raise exception 'Enter a valid phone number.';
  end if;
  perform pg_advisory_xact_lock(hashtext('book_slot'));
  perform pg_advisory_xact_lock(hashtext('book_slot:' || p_date::text));
  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then raise exception 'That time is already taken.'; end if;
  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, payment_status, paid_at)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), 'paid', now());
exception
  when unique_violation then
    raise exception 'That time is already taken.';
end;
$$;
revoke all on function public.admin_add_booking(date, time, text, text, text) from public, anon;
grant execute on function public.admin_add_booking(date, time, text, text, text) to authenticated;

-- ============================================================ TIDYING THE SCREENSHOTS
-- Screenshots (uploaded over a day ago) that no booking refers to: ones that were never used, and
-- ones whose booking has been deleted. The owner panel removes them through the Storage API.
create or replace function public.admin_stale_payment_proofs()
returns table (name text)
language sql stable security definer set search_path = public as $$
  select o.name::text
  from storage.objects o
  where public.is_owner()
    and o.bucket_id = 'payment-proofs'
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.bookings b where b.payment_proof_path = o.name)
  limit 200;
$$;
revoke all on function public.admin_stale_payment_proofs() from public, anon;
grant execute on function public.admin_stale_payment_proofs() to authenticated;

-- ============================================================ NOTIFICATION
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

select 'migration 16 applied' as result;
