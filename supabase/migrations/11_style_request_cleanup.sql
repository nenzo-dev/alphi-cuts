-- Version 2.3.0: old style requests are deleted automatically too, after keep_days.
--   * Requests without a photo are deleted by cleanup_old_records() (every 10 minutes).
--   * Requests with a photo are deleted by the owner panel when it opens: the photo has to be
--     removed through the Storage API (deleting storage rows in SQL would leave the file behind),
--     so the database only lists which ones are due.
--
-- Run once in the Supabase SQL editor after migration 10. schema.sql already includes this.

begin;

create or replace function public.cleanup_old_records()
returns void language plpgsql security definer set search_path = public as $$
declare v_keep int;
begin
  select keep_days into v_keep from public.site_config where id = 1;
  v_keep := greatest(coalesce(v_keep, 90), 7);
  delete from public.bookings
    where status = 'cancelled' and payment_status not in ('approved', 'paid');
  delete from public.bookings
    where status = 'no_show' and booking_date < public.shop_today() and payment_status not in ('approved', 'paid');
  delete from public.bookings where booking_date < public.shop_today() - v_keep;
  delete from public.chat_messages where created_at < now() - make_interval(days => v_keep);
  delete from public.style_requests
    where storage_path is null and created_at < now() - make_interval(days => v_keep);
end;
$$;
revoke execute on function public.cleanup_old_records() from public, anon, authenticated;

-- Style requests (with a photo) that are past keep_days, for the owner panel to delete.
create or replace function public.admin_expired_style_requests()
returns table (id uuid, storage_path text)
language sql stable security definer set search_path = public as $$
  select r.id, r.storage_path
  from public.style_requests r, public.site_config c
  where public.is_owner()
    and c.id = 1
    and r.created_at < now() - make_interval(days => c.keep_days)
  order by r.created_at;
$$;
grant execute on function public.admin_expired_style_requests() to authenticated;

select public.cleanup_old_records();

commit;

select 'migration 11 applied' as result;
