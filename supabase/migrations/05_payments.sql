-- Manual online-payment workflow (no payment gateway -- Alfred's own mobile money / bank details,
-- shown to a client only after he personally approves that specific booking for online payment,
-- and only actually marked "paid" once he says so himself after receiving the money). Also the
-- payment_status column doubles as what the owner panel and client ticket use to drive the UI.
-- Safe to run once on a project that already has schema.sql + migrations 02-04 applied (this file
-- is also folded into schema.sql itself, so a brand-new project only ever needs schema.sql alone).

create table public.payment_config (
  id int primary key default 1 check (id = 1),
  instructions text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.payment_config (id) values (1) on conflict (id) do nothing;
alter table public.payment_config enable row level security;
-- Deliberately no public select policy/grant here: payment details are only ever revealed through
-- get_payment_details() below, gated per-booking by payment_status, never as a direct table read.
create policy payment_config_owner_all on public.payment_config for all
  using (public.is_owner()) with check (public.is_owner());

alter table public.bookings add column if not exists payment_status text not null default 'none'
  check (payment_status in ('none', 'requested', 'approved', 'paid'));
alter table public.bookings add column if not exists payment_requested_at timestamptz;
alter table public.bookings add column if not exists payment_approved_at timestamptz;
alter table public.bookings add column if not exists paid_at timestamptz;

create or replace function public.admin_set_payment_details(p_instructions text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.payment_config set instructions = btrim(p_instructions), updated_at = now() where id = 1;
end;
$$;
grant execute on function public.admin_set_payment_details(text) to authenticated;

create or replace function public.admin_get_payment_details()
returns text language sql stable security definer set search_path = public as $$
  select instructions from public.payment_config where id = 1 and public.is_owner();
$$;
grant execute on function public.admin_get_payment_details() to authenticated;

-- A client flagging "I'd like to pay online" -- purely a nudge that shows up in the owner panel;
-- it does not reveal anything and can only move a fresh booking to 'requested'.
create or replace function public.request_online_payment(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set payment_status = 'requested', payment_requested_at = now()
  where client_token = p_token and payment_status = 'none';
  if not found then
    raise exception 'Online payment can''t be requested for this booking right now.';
  end if;
end;
$$;
grant execute on function public.request_online_payment(text) to anon, authenticated;

-- The actual gate: only the owner can move a booking to 'approved', and only once he has payment
-- details on file -- this is the single point where get_payment_details() starts returning them.
create or replace function public.admin_approve_payment(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_instructions text;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select instructions into v_instructions from public.payment_config where id = 1;
  if coalesce(btrim(v_instructions), '') = '' then
    raise exception 'Add your payment details under Shop details first.';
  end if;
  update public.bookings set payment_status = 'approved', payment_approved_at = now()
  where id = p_booking_id and payment_status in ('none', 'requested');
  if not found then raise exception 'This booking cannot be approved for online payment right now.'; end if;
end;
$$;
grant execute on function public.admin_approve_payment(uuid) to authenticated;

-- Only the owner, after he says he actually received the money -- never automatic, never
-- client-triggered. This is what unlocks the receipt on the client's side.
create or replace function public.admin_mark_paid(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set payment_status = 'paid', paid_at = now()
  where id = p_booking_id and payment_status = 'approved';
  if not found then raise exception 'Approve this booking for online payment first.'; end if;
end;
$$;
grant execute on function public.admin_mark_paid(uuid) to authenticated;

-- What the client's own device is allowed to see: the payment instructions themselves are only
-- included in the result once this exact booking has been approved (or paid).
create or replace function public.get_payment_details(p_token text)
returns table (payment_status text, instructions text, amount_kwacha numeric, shop_name text)
language plpgsql stable security definer set search_path = public as $$
declare v_status text;
begin
  select b.payment_status into v_status from public.bookings b where b.client_token = p_token;
  if v_status is null then raise exception 'Booking not found.'; end if;
  return query
    select
      v_status,
      case when v_status in ('approved', 'paid') then (select pc.instructions from public.payment_config pc where pc.id = 1) else null end,
      (select sc.price_kwacha from public.site_config sc where sc.id = 1),
      (select sc.shop_name from public.site_config sc where sc.id = 1);
end;
$$;
grant execute on function public.get_payment_details(text) to anon, authenticated;

select 'migration 05 applied' as result;
