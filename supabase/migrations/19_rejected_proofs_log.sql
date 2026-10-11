-- 2.12.2: a turned-down screenshot only says "fake proof of payment" to the client; the reasons go to the owner.
--
-- 1. The page no longer tells a client why a screenshot was turned down (that would show them how to
--    get a fake past the checks). It says only that it looks like fake proof of payment, and to call
--    the owner. The reasons are sent here with the picture (log_rejected_proof) and the owner reads them
--    in the panel (Payments > Turned-down screenshots) when the client calls.
-- 2. book_slot() no longer explains why a payment was refused either: one plain message.
-- 3. Turned-down records and their pictures are deleted after 14 days.
--
-- Run once in the Supabase SQL editor, after 18_sign_name_drop_sms.sql.

create table public.rejected_proofs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  device_token text,                -- the browser that sent it, to tell attempts apart
  reasons text[] not null default '{}',   -- why it was turned down: for the owner only, never shown to the client
  proof jsonb not null,             -- what was read from it, and the file's details
  path text,                        -- the picture, in the payment-proofs bucket (if it uploaded)
  sha256 text
);
create index rejected_proofs_created on public.rejected_proofs (created_at desc);
alter table public.rejected_proofs enable row level security;
create policy rejected_proofs_owner_all on public.rejected_proofs for all
  using (public.is_owner()) with check (public.is_owner());

-- What the page sends when it turns a screenshot down, so the owner can see why when the client calls.
-- Quietly ignored when it looks wrong or too many come from one browser.
create or replace function public.log_rejected_proof(p_proof jsonb, p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_device text := case when public.valid_token(p_device) then p_device end;
  v_path text := nullif(p_proof->>'path', '');
  v_hash text := lower(coalesce(p_proof->>'sha256', ''));
begin
  if p_proof is null or jsonb_typeof(p_proof) <> 'object' or pg_column_size(p_proof) > 30000 then return; end if;
  if v_hash !~ '^[0-9a-f]{64}$' then return; end if;
  if v_path is not null and not public.valid_token(split_part(v_path, '/', 1)) then v_path := null; end if;
  if v_device is not null and (select count(*) from public.rejected_proofs
       where device_token = v_device and created_at > now() - interval '1 hour') >= 20 then return; end if;
  insert into public.rejected_proofs (device_token, reasons, proof, path, sha256)
  values (v_device,
          coalesce(array(select left(x, 300) from jsonb_array_elements_text(
            case when jsonb_typeof(p_proof->'reasons') = 'array' then p_proof->'reasons' else '[]'::jsonb end) x limit 12), '{}'),
          p_proof - 'ocr', v_path, v_hash);
end;
$$;
grant execute on function public.log_rejected_proof(jsonb, text) to anon, authenticated;

create or replace function public.admin_list_rejected_proofs(p_limit int default 30)
returns setof public.rejected_proofs
language sql stable security definer set search_path = public as $$
  select * from public.rejected_proofs
  where public.is_owner()
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
revoke all on function public.admin_list_rejected_proofs(int) from public, anon;
grant execute on function public.admin_list_rejected_proofs(int) to authenticated;

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
      raise exception 'That payment screenshot was not accepted. If you really paid, please call the shop to confirm.';
    end if;
    if p_proof->'extracted'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' and p_proof->'extracted'->>'pay_time' ~ '^\d{2}:\d{2}$'
       and public.shop_now() - ((p_proof->'extracted'->>'date')::date + (p_proof->'extracted'->>'pay_time')::time) > interval '70 minutes' then
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

create or replace function public.admin_stale_payment_proofs()
returns table (name text)
language sql stable security definer set search_path = public as $$
  select o.name::text
  from storage.objects o
  where public.is_owner()
    and o.bucket_id = 'payment-proofs'
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.bookings b where b.payment_proof_path = o.name)
    and not exists (select 1 from public.rejected_proofs r where r.path = o.name)
  limit 200;
$$;
revoke all on function public.admin_stale_payment_proofs() from public, anon;
grant execute on function public.admin_stale_payment_proofs() to authenticated;

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
  delete from public.rejected_proofs where created_at < now() - interval '14 days';
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

select 'migration 19 applied' as result;
