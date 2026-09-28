-- Small follow-up to 02_two_ahead_owners_styles.sql:
--   1. Defensive storage grants (harmless if already present on this project).
--   2. admin_list_style_photos(): like list_haircut_styles(), but also returns each photo's id, so
--      the owner panel's "Styles" tab can delete one specific photo.
-- Safe to run once on a project that already has schema.sql + migration 02 applied (this file is
-- also folded into schema.sql itself, so a brand-new project only ever needs to run schema.sql alone).

grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;

create or replace function public.admin_list_style_photos()
returns table (style_id uuid, label text, sort_order int, photo_id uuid, storage_path text, photo_order int)
language sql stable security definer set search_path = public as $$
  select s.id, s.label, s.sort_order, p.id, p.storage_path, p.sort_order
  from public.haircut_styles s
  left join public.haircut_style_photos p on p.style_id = s.id
  where public.is_owner()
  order by s.sort_order, s.created_at, p.sort_order;
$$;
grant execute on function public.admin_list_style_photos() to authenticated;

select 'migration 03 applied' as result;
