-- Real bug found while testing: get_my_booking() was declared to return a single public.bookings
-- row (not SETOF). Postgres always returns exactly one row for a non-SETOF composite return, so
-- when a token matched nothing, the "row" came back with every column NULL instead of "no result" --
-- the app then crashed trying to read booking_date/slot_time off that all-null object. Switching to
-- SETOF makes "no booking" come back as a genuinely empty array, matching how the JS already checks
-- for "not found" everywhere else. The function's return type is changing, so CREATE OR REPLACE
-- can't be used -- it has to be dropped and recreated.

drop function if exists public.get_my_booking(text);

create or replace function public.get_my_booking(p_token text)
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings where client_token = p_token;
$$;
grant execute on function public.get_my_booking(text) to anon, authenticated;

select 'migration 07 applied' as result;
