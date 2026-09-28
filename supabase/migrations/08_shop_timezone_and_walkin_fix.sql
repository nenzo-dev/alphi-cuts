-- Two real bugs found while investigating "bookings not appearing for the owner" and "Add walk-in
-- isn't working":
--
-- 1. Several functions used bare current_date / now(), which run in the DATABASE's own timezone
--    (UTC on Supabase), not the shop's. Since Zambia is UTC+2, current_date silently disagreed with
--    the shop's actual calendar date for the first two hours of every Zambia day. New shop_today()
--    helper fixes this everywhere "today" matters: public_queue_today(), book_slot()'s past-date
--    check, and admin_add_walkin().
--
-- 2. admin_add_walkin() had its own separate bug: it advanced the next walk-in's slot time by a
--    hardcoded 1 minute instead of the shop's actual slot length (slot_minutes, 20 by default), so
--    walk-ins landed at odd times like 08:01/08:02 instead of proper slots like 08:20/08:40. Fixed
--    to use site_config.slot_minutes.
--
-- Safe to run once on a project that already has schema.sql + migrations 02-07 applied (this file
-- is also folded into schema.sql itself, so a brand-new project only ever needs schema.sql alone).

create or replace function public.shop_today()
returns date language sql stable as $$
  select (now() at time zone 'Africa/Lusaka')::date;
$$;

create or replace function public.public_queue_today()
returns table (slot_time time, status text, called_at timestamptz)
language sql stable security definer set search_path = public as $$
  select slot_time, status, called_at
  from public.bookings
  where booking_date = public.shop_today()
    and status not in ('cancelled')
  order by slot_time;
$$;

create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_token text;
  v_open time; v_close time; v_slot_minutes int;
begin
  select open_time, close_time, slot_minutes into v_open, v_close, v_slot_minutes from public.site_config where id = 1;

  if p_date < public.shop_today() then
    raise exception 'That date has already passed.';
  end if;
  if p_slot < v_open or p_slot >= v_close then
    raise exception 'That time is outside opening hours.';
  end if;
  if extract(epoch from (p_slot - v_open)) % (v_slot_minutes * 60) <> 0 then
    raise exception 'Please pick one of the listed time slots.';
  end if;
  if btrim(p_name) = '' or btrim(p_phone) = '' then
    raise exception 'Name and phone number are both required.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice)
  values (p_date, p_slot, btrim(p_name), btrim(p_phone), nullif(btrim(coalesce(p_style, '')), ''))
  returning client_token into v_token;

  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken -- please pick another.';
end;
$$;

create or replace function public.admin_add_walkin(p_name text, p_phone text)
returns void language plpgsql security definer set search_path = public as $$
declare v_slot time; v_open time; v_slot_minutes int; v_today date;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select open_time, slot_minutes into v_open, v_slot_minutes from public.site_config where id = 1;
  v_today := public.shop_today();
  select coalesce(max(slot_time) + make_interval(mins => v_slot_minutes), v_open)
    into v_slot
    from public.bookings where booking_date = v_today and status not in ('cancelled', 'no_show');
  insert into public.bookings (booking_date, slot_time, client_name, client_phone, status)
  values (v_today, v_slot, btrim(p_name), coalesce(nullif(btrim(p_phone), ''), 'walk-in'), 'checked_in');
end;
$$;

select 'migration 08 applied' as result;
