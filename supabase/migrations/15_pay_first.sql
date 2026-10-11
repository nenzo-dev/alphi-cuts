-- 2.11.0: pay first, then book.
--
-- 1. The owner can switch on "Pay before booking". While it is on (and payment details are saved),
--    book_slot() needs the payment reference from the client's own payment message, and the
--    booking starts as payment_status 'submitted': it holds the slot, but the owner has to confirm
--    the money arrived ("Mark paid", or "Not received" to cancel it). One reference can only back
--    one booking.
-- 2. The payment details saved in the owner panel are shown to everyone on the booking form
--    (get_pay_info()), instead of only to clients the owner approved one by one.
-- 3. A booking still unconfirmed when its slot starts is cleared by expire_payment_requests() (every
--    minute, the same cron job as before), unless the client is already at the shop. An unconfirmed
--    booking is never started automatically (auto_start_due()); the owner can still start it.
--
-- Run once in the Supabase SQL editor, after 14_one_booking_and_payment_expiry.sql.

-- ============================================================ COLUMNS
alter table public.site_config add column if not exists require_payment boolean not null default true;

alter table public.bookings add column if not exists payment_ref text;            -- from the client's payment message
alter table public.bookings add column if not exists payment_submitted_at timestamptz;

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.bookings'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%payment_status%'
  loop
    execute format('alter table public.bookings drop constraint %I', r.conname);
  end loop;
end
$$;
alter table public.bookings add constraint bookings_payment_status_check
  check (payment_status in ('none', 'requested', 'approved', 'submitted', 'paid', 'rejected'));
alter table public.bookings drop constraint if exists bookings_payment_ref_check;
alter table public.bookings add constraint bookings_payment_ref_check
  check (payment_ref is null or length(payment_ref) between 5 and 40);

-- One payment reference backs one booking at a time (a cancelled booking frees it).
create unique index if not exists bookings_payment_ref_used
  on public.bookings (lower(payment_ref))
  where payment_ref is not null and status <> 'cancelled';

-- ============================================================ WHAT THE PUBLIC SEES
-- Whether payment is needed before booking, the details to pay to, and the price. Everyone can read
-- this: the details are meant to be shown to every client who is about to pay.
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

create or replace function public.admin_set_payment_required(p_required boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if coalesce(p_required, false) and coalesce(btrim((select instructions from public.payment_config where id = 1)), '') = '' then
    raise exception 'Save your payment details first, so clients know where to pay.';
  end if;
  update public.site_config set require_payment = coalesce(p_required, false), updated_at = now() where id = 1;
end;
$$;
revoke all on function public.admin_set_payment_required(boolean) from public, anon;
grant execute on function public.admin_set_payment_required(boolean) to authenticated;

-- ============================================================ BOOKING: PAYMENT REFERENCE
drop function if exists public.book_slot(date, time, text, text, text, text);
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null, p_device text default null,
  p_pay_ref text default null
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
  if v_pay and (length(v_ref) < 5 or length(v_ref) > 40 or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._/:#-]*$') then
    raise exception 'Please pay first, then enter the reference from your payment message (5 to 40 letters and numbers).';
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

  -- One payment, one booking.
  if v_pay and exists (
    select 1 from public.bookings where lower(payment_ref) = lower(v_ref) and status <> 'cancelled'
  ) then
    raise exception 'That payment reference has already been used for a booking. Each payment is for one booking.';
  end if;

  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token,
                               payment_status, payment_ref, payment_submitted_at)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), v_device,
          case when v_pay then 'submitted' else 'none' end,
          case when v_pay then v_ref end,
          case when v_pay then now() end)
  returning client_token into v_token;
  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken. Please pick another.';
end;
$$;
grant execute on function public.book_slot(date, time, text, text, text, text, text) to anon, authenticated;

-- ============================================================ CANCELLING AND CONFIRMING
-- A booking with a payment behind it (approved, submitted or paid) is cancelled, not deleted, so the
-- payment can be traced.
create or replace function public.cancel_my_booking(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.bookings
  where client_token = p_token
    and status in ('booked', 'on_deck', 'called', 'checked_in')
    and payment_status not in ('approved', 'submitted', 'paid');
  if found then return; end if;
  update public.bookings set status = 'cancelled'
  where client_token = p_token and status in ('booked', 'on_deck', 'called', 'checked_in');
  if not found then
    raise exception 'This booking can''t be cancelled any more.';
  end if;
end;
$$;
grant execute on function public.cancel_my_booking(text) to anon, authenticated;

create or replace function public.admin_cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.bookings
  where id = p_booking_id
    and status in ('booked', 'on_deck', 'called', 'checked_in')
    and payment_status not in ('approved', 'submitted', 'paid');
  if found then return; end if;
  update public.bookings set status = 'cancelled'
  where id = p_booking_id and status in ('booked', 'on_deck', 'called', 'checked_in');
  if not found then raise exception 'That booking can''t be cancelled. Refresh the list and try again.'; end if;
end;
$$;
grant execute on function public.admin_cancel_booking(uuid) to authenticated;

-- The owner says the money arrived (after approving it, or after a client submitted a reference).
create or replace function public.admin_mark_paid(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set payment_status = 'paid', paid_at = now()
  where id = p_booking_id and payment_status in ('approved', 'submitted')
    and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair', 'done');
  if not found then raise exception 'That payment can''t be marked as paid any more. Refresh the list and try again.'; end if;
end;
$$;
grant execute on function public.admin_mark_paid(uuid) to authenticated;

-- The owner can't find the payment: the booking is cancelled and the slot is free again.
create or replace function public.admin_reject_payment(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'cancelled', payment_status = 'rejected'
  where id = p_booking_id and payment_status = 'submitted'
    and status in ('booked', 'on_deck', 'called', 'checked_in');
  if not found then raise exception 'That payment can''t be marked as not received any more. Refresh the list and try again.'; end if;
end;
$$;
revoke all on function public.admin_reject_payment(uuid) from public, anon;
grant execute on function public.admin_reject_payment(uuid) to authenticated;

create or replace function public.admin_list_pending_payments()
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where public.is_owner()
    and (payment_status in ('requested', 'approved')
         or (payment_status = 'submitted' and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')))
  order by booking_date, slot_time;
$$;
grant execute on function public.admin_list_pending_payments() to authenticated;

-- ============================================================ QUEUE: UNCONFIRMED PAYMENTS
-- An unconfirmed booking is never started automatically (the owner can still start it by hand).
create or replace function public.auto_start_due()
returns int language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_today date := public.shop_today();
  v_now int := public.minute_of(public.shop_now()::time);
  v_next uuid;
  v_busy_since timestamptz;
begin
  select * into c from public.site_config where id = 1;
  if not c.auto_start then return 0; end if;
  select id into v_next from public.bookings
    where booking_date = v_today and status = 'checked_in' and public.minute_of(slot_time) <= v_now
      and payment_status <> 'submitted'
    order by slot_time limit 1;
  if v_next is null then return 0; end if;
  select max(started_at) into v_busy_since from public.bookings where booking_date = v_today and status = 'in_chair';
  if v_busy_since is not null and v_busy_since > now() - make_interval(mins => 2 * c.slot_minutes) then return 0; end if;
  if public.start_cut_internal(v_next) then return 1; end if;
  return 0;
end;
$$;
revoke all on function public.auto_start_due() from public, anon, authenticated;

-- Every minute: requests still waiting for approval when the slot starts are cleared, and so are
-- bookings whose payment still wasn't confirmed by then (unless the client is already at the shop).
-- The client is told if they turned notifications on; the booking on the page says so too.
create or replace function public.expire_payment_requests()
returns int language plpgsql security definer set search_path = public as $$
declare
  b record;
  v_count int := 0;
begin
  for b in
    update public.bookings
    set payment_status = 'none', payment_requested_at = null, payment_expired_at = now()
    where payment_status = 'requested' and booking_date + slot_time <= public.shop_now()
    returning id, client_token, booking_date, slot_time, status
  loop
    v_count := v_count + 1;
    if b.booking_date = public.shop_today() and b.status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair') then
      perform public.push_queue('booking', b.client_token, 'Online payment request cleared',
        public.push_text('pay_expired', 'Your request to pay online wasn''t approved before your slot, so it was cleared. Please pay at the shop.', b.slot_time),
        './#book', 'pay-' || b.client_token, false, 'payexp:' || b.id);
    end if;
  end loop;

  for b in
    update public.bookings
    set status = 'cancelled', payment_expired_at = now()
    where payment_status = 'submitted' and status in ('booked', 'on_deck', 'called')
      and booking_date + slot_time <= public.shop_now()
    returning id, client_token, booking_date, slot_time
  loop
    v_count := v_count + 1;
    if b.booking_date = public.shop_today() then
      perform public.push_queue('booking', b.client_token, 'Payment not confirmed',
        public.push_text('pay_unconfirmed', 'Your payment for {time} wasn''t confirmed before your slot, so the booking was cleared. If you did pay, message {owner_first} with your payment reference.', b.slot_time),
        './#book', 'pay-' || b.client_token, false, 'payexp:' || b.id);
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.expire_payment_requests() from public, anon, authenticated;

-- ============================================================ NOTIFICATIONS
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
        perform public.push_queue('owners', 'owners', 'New booking: confirm payment',
          new.client_name || ', ' || v_when || '. Payment reference ' || new.payment_ref || '.',
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

-- ============================================================ CLEANUP
-- Cancelled bookings that had a payment behind them (approved, submitted or paid) are kept so the
-- payment can be traced, until they age out with the rest.
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

select 'migration 15 applied' as result;
