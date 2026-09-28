-- Small follow-up to 05_payments.sql: a cross-date list for the owner panel's Payments tab, since
-- admin_bookings_for_date() only covers one day and a client can ask to pay online for any booked
-- date. Safe to run once on a project that already has schema.sql + migrations 02-05 applied (this
-- file is also folded into schema.sql itself, so a brand-new project only ever needs schema.sql alone).

create or replace function public.admin_list_pending_payments()
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where public.is_owner() and payment_status in ('requested', 'approved')
  order by booking_date, slot_time;
$$;
grant execute on function public.admin_list_pending_payments() to authenticated;

select 'migration 06 applied' as result;
