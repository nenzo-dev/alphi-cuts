-- 2.13.0: strict screenshot checks.
--
-- book_slot() now refuses a payment screenshot unless:
--   * the file was saved in the last hour;
--   * the payment on it (the date and the time in the transaction ID) is from the last hour;
--   * the owner's name was found on it, and so was the account from his payment details (when there is one).
-- A missing or unreadable value is refused too. The page checks the same things, and more, first; this is the
-- second lock. No new tables. Run once in the Supabase SQL editor, after 19_rejected_proofs_log.sql.

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
  v_mod timestamptz;
  v_pay_at timestamp;
  v_acct boolean;
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
    -- Strict, like the page (a little looser for clocks that differ): when the file was saved and when the payment
    -- was made must both be from the last hour, and the payment must have been made to the owner: his name has
    -- to be on the screenshot, and so does the account from his payment details when there is one.
    -- A missing or unreadable value is a no.
    begin
      v_mod := (p_proof->'file'->>'modified')::timestamptz;
      v_pay_at := (p_proof->'extracted'->>'date')::date + (p_proof->'extracted'->>'pay_time')::time;
    exception when others then
      v_mod := null;
      v_pay_at := null;
    end;
    v_acct := exists (
      select 1 from regexp_matches(coalesce((select instructions from public.payment_config where id = 1), ''), '[0-9][0-9 ]{4,}[0-9]', 'g') m
      where length(regexp_replace(m[1], '\D', '', 'g')) between 6 and 15);
    if v_mod is null or v_pay_at is null
       or now() - v_mod > interval '65 minutes' or v_mod - now() > interval '10 minutes'
       or public.shop_now() - v_pay_at > interval '65 minutes' or v_pay_at - public.shop_now() > interval '10 minutes'
       or (p_proof->'extracted'->>'recipient_ok') is distinct from 'true'
       or (v_acct and (p_proof->'extracted'->>'account_ok') is distinct from 'true') then
      raise exception 'That payment screenshot was not accepted. If you really paid, please call the shop to confirm.';
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
    raise exception 'That payment screenshot was not accepted. If you really paid, please call the shop to confirm.';
  end if;
  if v_pay and exists (
    select 1 from public.bookings where payment_proof_hash = v_hash and payment_status <> 'rejected'
  ) then
    raise exception 'That payment screenshot was not accepted. If you really paid, please call the shop to confirm.';
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

select 'migration 20 applied' as result;
