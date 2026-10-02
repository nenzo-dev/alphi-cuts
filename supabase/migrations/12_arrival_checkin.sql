-- Version 2.5.0: clients are checked in automatically when they arrive at the shop, and go into the
-- chair automatically when their slot starts.
--
-- The owner sets the shop's location once (owner panel, Settings). A client who turns on "Check me in
-- when I arrive" has their phone compare its position with the shop's on the day of the booking, from
-- two hours before the slot until it ends. Inside the arrival distance the phone calls
-- arrive_at_shop(), which checks the distance again here. The position itself is never stored, only
-- that the client arrived (bookings.arrived_auto).
--
-- Every minute, auto_start_due() puts the next checked-in client whose slot has started in the
-- chair, once the chair is free (or the cut in it has clearly been left running).

-- ============================================================ SETTINGS
alter table public.site_config
  add column if not exists shop_lat double precision,
  add column if not exists shop_lng double precision,
  add column if not exists arrival_radius_m int not null default 150,
  add column if not exists auto_checkin boolean not null default true,
  add column if not exists auto_start boolean not null default true;
alter table public.site_config drop constraint if exists site_config_location_check;
alter table public.site_config add constraint site_config_location_check check (
  (shop_lat is null) = (shop_lng is null)
  and (shop_lat is null or (shop_lat between -90 and 90 and shop_lng between -180 and 180))
  and arrival_radius_m between 30 and 1000
);

alter table public.bookings add column if not exists arrived_auto boolean not null default false;

-- Owner panel: the shop's location, how close counts as arrived, and the two automatic steps.
create or replace function public.admin_set_arrival(
  p_lat double precision, p_lng double precision, p_radius int, p_auto_checkin boolean, p_auto_start boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'Enter both the latitude and the longitude, or leave both empty.';
  end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then
    raise exception 'That location isn''t valid. Check the latitude and longitude.';
  end if;
  if coalesce(p_radius, 150) not between 30 and 1000 then
    raise exception 'The arrival distance must be between 30 and 1000 metres.';
  end if;
  update public.site_config
     set shop_lat = p_lat, shop_lng = p_lng, arrival_radius_m = coalesce(p_radius, 150),
         auto_checkin = coalesce(p_auto_checkin, true), auto_start = coalesce(p_auto_start, true),
         updated_at = now()
   where id = 1;
end;
$$;
revoke all on function public.admin_set_arrival(double precision, double precision, int, boolean, boolean) from public, anon;
grant execute on function public.admin_set_arrival(double precision, double precision, int, boolean, boolean) to authenticated;

-- ============================================================ ARRIVING
-- Metres between two points on the Earth (haversine).
create or replace function public.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))));
$$;

-- The client's phone says it's at (p_lat, p_lng), accurate to p_accuracy metres. Inside the arrival
-- distance, on the day of the booking from two hours before the slot until it ends, the booking is
-- checked in. Answers what happened: checked_in, too_far (with the distance), not_now, not_waiting
-- or off. The position isn't kept.
create or replace function public.arrive_at_shop(p_token text, p_lat double precision, p_lng double precision, p_accuracy double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  b public.bookings;
  v_now timestamp := public.shop_now();
  v_slack double precision := least(greatest(coalesce(p_accuracy, 0), 0), 100);
  v_dist double precision;
begin
  if not public.valid_token(p_token) then raise exception 'That booking could not be found.'; end if;
  select * into c from public.site_config where id = 1;
  if not c.auto_checkin or c.shop_lat is null then return jsonb_build_object('result', 'off'); end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('result', 'too_far');
  end if;
  select * into b from public.bookings where client_token = p_token;
  if not found then raise exception 'That booking could not be found.'; end if;
  if b.status = 'checked_in' then return jsonb_build_object('result', 'checked_in'); end if;
  if b.status not in ('booked', 'on_deck', 'called') or b.booking_date <> public.shop_today() then
    return jsonb_build_object('result', 'not_waiting');
  end if;
  if v_now < b.booking_date + b.slot_time - interval '2 hours'
     or v_now > b.booking_date + b.slot_time + make_interval(mins => c.slot_minutes) then
    return jsonb_build_object('result', 'not_now');
  end if;
  v_dist := public.distance_m(c.shop_lat, c.shop_lng, p_lat, p_lng);
  if v_dist > c.arrival_radius_m + v_slack then
    return jsonb_build_object('result', 'too_far', 'distance_m', round(v_dist::numeric));
  end if;
  update public.bookings set status = 'checked_in', checked_in_at = now(), arrived_auto = true
   where id = b.id and status in ('booked', 'on_deck', 'called');
  return jsonb_build_object('result', 'checked_in', 'distance_m', round(v_dist::numeric));
end;
$$;
revoke all on function public.arrive_at_shop(text, double precision, double precision, double precision) from public;
grant execute on function public.arrive_at_shop(text, double precision, double precision, double precision) to anon, authenticated;

-- ============================================================ STARTING A CUT
-- One chair: starting a cut finishes whoever was still marked as in the chair, then alerts the next
-- two people (the next one is "called", the one after is "on deck"). Shared by the owner's "Start
-- cut" and the automatic start below; false when that booking can't be started.
create or replace function public.start_cut_internal(p_booking_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_len int;
  v_now int := public.minute_of(public.shop_now()::time);
  v_next_id uuid;
  v_next2_id uuid;
begin
  select slot_minutes into v_len from public.site_config where id = 1;
  update public.bookings set status = 'in_chair', started_at = now()
  where id = p_booking_id and status in ('booked', 'on_deck', 'called', 'checked_in')
  returning booking_date into v_date;
  if not found then return false; end if;

  update public.bookings set status = 'done', finished_at = now()
  where booking_date = v_date and status = 'in_chair' and id <> p_booking_id;

  select id into v_next_id from public.bookings
    where booking_date = v_date and id <> p_booking_id and status in ('booked', 'on_deck', 'called')
      and public.minute_of(slot_time) + v_len > v_now
    order by slot_time limit 1;
  if v_next_id is not null then
    update public.bookings set status = 'called', called_at = now() where id = v_next_id;
    select id into v_next2_id from public.bookings
      where booking_date = v_date and id not in (p_booking_id, v_next_id) and status in ('booked', 'on_deck', 'called')
        and public.minute_of(slot_time) + v_len > v_now
      order by slot_time limit 1;
    if v_next2_id is not null then
      update public.bookings set status = 'on_deck', on_deck_at = now() where id = v_next2_id;
    end if;
  end if;
  return true;
end;
$$;
revoke all on function public.start_cut_internal(uuid) from public, anon, authenticated;

create or replace function public.admin_start_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if not public.start_cut_internal(p_booking_id) then
    raise exception 'That booking can''t be started. Refresh the list and try again.';
  end if;
end;
$$;

-- Every minute (pg_cron): the next checked-in client whose slot has started goes into the chair, if
-- the chair is free, or if the cut in it has run for more than two slots (left running by mistake).
-- Answers how many cuts it started (0 or 1).
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
    order by slot_time limit 1;
  if v_next is null then return 0; end if;
  select max(started_at) into v_busy_since from public.bookings where booking_date = v_today and status = 'in_chair';
  if v_busy_since is not null and v_busy_since > now() - make_interval(mins => 2 * c.slot_minutes) then return 0; end if;
  if public.start_cut_internal(v_next) then return 1; end if;
  return 0;
end;
$$;
revoke all on function public.auto_start_due() from public, anon, authenticated;

do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-autostart';
  perform cron.schedule('alphicuts-autostart', '* * * * *', 'select public.auto_start_due()');
exception when others then
  raise notice 'pg_cron is not available (%); cuts are only started from the owner panel.', sqlerrm;
end
$cron$;

select 'migration 12 applied' as result;
