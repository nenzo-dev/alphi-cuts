-- 2.8.0: one booking per person, and online payment requests that run out at the slot time.
--
-- 1. A person can hold one booking at a time. book_slot() refuses a new booking while the same phone
--    number, or the same device, already has one waiting or in the chair (today or later). Cancelling
--    the booking, or the cut being done, frees them to book again.
-- 2. A request to pay online that the owner hasn't approved by the time the slot starts is cleared
--    (expire_payment_requests(), every minute). The client gets a notification if they turned them
--    on, and their booking says so. Requests can't be made once the slot has started.
--
-- Run once in the Supabase SQL editor, after 13_push_notifications.sql.

alter table public.bookings add column if not exists payment_expired_at timestamptz;  -- request cleared at the slot time

-- ============================================================ BOOKING: ONE AT A TIME PER PERSON
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null, p_device text default null
) returns text   -- the new booking's client_token
language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_token text;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_device text := case when public.valid_token(p_device) then p_device end;
  v_start int;
begin
  select * into c from public.site_config where id = 1;

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

  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), v_device)
  returning client_token into v_token;
  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken. Please pick another.';
end;
$$;
grant execute on function public.book_slot(date, time, text, text, text, text) to anon, authenticated;

-- ============================================================ ONLINE PAYMENT: ONLY BEFORE THE SLOT
create or replace function public.request_online_payment(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings
  set payment_status = 'requested', payment_requested_at = now(), payment_expired_at = null
  where client_token = p_token
    and payment_status = 'none'
    and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
    and booking_date + slot_time > public.shop_now();
  if found then return; end if;
  if exists (
    select 1 from public.bookings
    where client_token = p_token and payment_status = 'none' and booking_date + slot_time <= public.shop_now()
  ) then
    raise exception 'Your slot has already started, so you can''t ask to pay online now. Please pay at the shop.';
  end if;
  raise exception 'Online payment can''t be requested for this booking right now.';
end;
$$;
grant execute on function public.request_online_payment(text) to anon, authenticated;

-- Every minute: requests still waiting for approval when the slot starts are cleared, and the client
-- is told (if they turned notifications on; the booking on the page says so too).
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
  return v_count;
end;
$$;
revoke all on function public.expire_payment_requests() from public, anon, authenticated;

do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-payments';
  perform cron.schedule('alphicuts-payments', '* * * * *', 'select public.expire_payment_requests()');
exception when others then
  raise notice 'pg_cron is not available (%); payment requests are not cleared automatically.', sqlerrm;
end
$cron$;

select public.expire_payment_requests();
