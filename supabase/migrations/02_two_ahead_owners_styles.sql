-- Incremental migration on top of the original schema.sql:
--   1. Bookings can now be "on_deck" (2 away) as well as "called" (next), so both the next person
--      AND the one after them get alerted to stick around.
--   2. Owner management: add/remove co-owners by email, from the owner panel itself.
--   3. Admin-uploadable haircut styles (Supabase Storage), on top of the 36 built-in photos.
--   4. Style requests: a client can describe or upload a photo of a style that isn't in the gallery.
-- Safe to run once on a project that already has schema.sql applied (this file is also folded into
-- schema.sql itself, so a brand-new project only ever needs to run schema.sql alone).

alter table public.bookings add column if not exists on_deck_at timestamptz;
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair', 'done', 'no_show', 'cancelled'));

create or replace function public.check_in(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'checked_in', checked_in_at = now()
  where client_token = p_token and status in ('booked', 'on_deck', 'called');
  if not found then
    raise exception 'This booking cannot be checked in right now.';
  end if;
end;
$$;

create or replace function public.admin_start_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_date date; v_slot time; v_next_id uuid; v_next2_id uuid;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'in_chair', started_at = now()
  where id = p_booking_id returning booking_date, slot_time into v_date, v_slot;

  select id into v_next_id from public.bookings
    where booking_date = v_date and slot_time > v_slot and status in ('booked', 'on_deck', 'called')
    order by slot_time limit 1;
  if v_next_id is not null then
    update public.bookings set status = 'called', called_at = now() where id = v_next_id;
  end if;

  select id into v_next2_id from public.bookings
    where booking_date = v_date and slot_time > v_slot and status in ('booked', 'on_deck', 'called') and id <> v_next_id
    order by slot_time limit 1;
  if v_next2_id is not null then
    update public.bookings set status = 'on_deck', on_deck_at = now() where id = v_next2_id;
  end if;
end;
$$;

create or replace function public.am_i_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_owner();
$$;
grant execute on function public.am_i_owner() to authenticated;

create or replace function public.admin_add_owner_by_email(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select id into v_uid from auth.users where lower(email) = lower(btrim(p_email));
  if v_uid is null then
    raise exception 'No account found with that email. Ask them to open the owner login page and use "Set up the owner account" first, then try adding them again.';
  end if;
  insert into public.profiles (id, full_name, role) values (v_uid, split_part(p_email, '@', 1), 'owner')
  on conflict (id) do update set role = 'owner';
end;
$$;
grant execute on function public.admin_add_owner_by_email(text) to authenticated;

create or replace function public.admin_remove_owner(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if (select count(*) from public.profiles where role = 'owner') <= 1 then
    raise exception 'At least one owner must always remain.';
  end if;
  delete from public.profiles where id = p_id;
end;
$$;
grant execute on function public.admin_remove_owner(uuid) to authenticated;

create or replace function public.admin_list_owners()
returns table (id uuid, full_name text, email text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, u.email, p.created_at
  from public.profiles p join auth.users u on u.id = p.id
  where public.is_owner()
  order by p.created_at;
$$;
grant execute on function public.admin_list_owners() to authenticated;

create table public.haircut_styles (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create table public.haircut_style_photos (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.haircut_styles(id) on delete cascade,
  storage_path text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.haircut_styles enable row level security;
alter table public.haircut_style_photos enable row level security;
create policy haircut_styles_select_all on public.haircut_styles for select using (true);
create policy haircut_style_photos_select_all on public.haircut_style_photos for select using (true);
grant select on public.haircut_styles, public.haircut_style_photos to anon, authenticated;

create or replace function public.list_haircut_styles()
returns table (style_id uuid, label text, sort_order int, storage_path text, photo_order int)
language sql stable as $$
  select s.id, s.label, s.sort_order, p.storage_path, p.sort_order
  from public.haircut_styles s
  left join public.haircut_style_photos p on p.style_id = s.id
  order by s.sort_order, s.created_at, p.sort_order;
$$;
grant execute on function public.list_haircut_styles() to anon, authenticated;

create or replace function public.admin_create_style(p_label text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  insert into public.haircut_styles (label) values (btrim(p_label)) returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.admin_create_style(text) to authenticated;

create or replace function public.admin_add_style_photo(p_style_id uuid, p_storage_path text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  insert into public.haircut_style_photos (style_id, storage_path) values (p_style_id, p_storage_path);
end;
$$;
grant execute on function public.admin_add_style_photo(uuid, text) to authenticated;

create or replace function public.admin_delete_style_photo(p_photo_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.haircut_style_photos where id = p_photo_id;
end;
$$;
grant execute on function public.admin_delete_style_photo(uuid) to authenticated;

create or replace function public.admin_delete_style(p_style_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.haircut_styles where id = p_style_id;
end;
$$;
grant execute on function public.admin_delete_style(uuid) to authenticated;

create table public.style_requests (
  id uuid primary key default gen_random_uuid(),
  client_token text not null,
  description text not null default '',
  storage_path text,
  created_at timestamptz not null default now()
);
alter table public.style_requests enable row level security;
create policy style_requests_owner_all on public.style_requests for all
  using (public.is_owner()) with check (public.is_owner());

create or replace function public.submit_style_request(p_token text, p_description text, p_storage_path text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if btrim(coalesce(p_description, '')) = '' and p_storage_path is null then
    raise exception 'Describe the style or upload a photo of it.';
  end if;
  insert into public.style_requests (client_token, description, storage_path)
  values (p_token, coalesce(btrim(p_description), ''), p_storage_path);
end;
$$;
grant execute on function public.submit_style_request(text, text, text) to anon, authenticated;

create or replace function public.admin_list_style_requests()
returns setof public.style_requests
language sql stable security definer set search_path = public as $$
  select * from public.style_requests where public.is_owner() order by created_at desc;
$$;
grant execute on function public.admin_list_style_requests() to authenticated;

create or replace function public.admin_delete_style_request(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.style_requests where id = p_id;
end;
$$;
grant execute on function public.admin_delete_style_request(uuid) to authenticated;

insert into storage.buckets (id, name, public) values ('haircut-styles', 'haircut-styles', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('style-requests', 'style-requests', false)
  on conflict (id) do nothing;

create policy haircut_styles_bucket_read on storage.objects for select
  using (bucket_id = 'haircut-styles');
create policy haircut_styles_bucket_write on storage.objects for insert
  with check (bucket_id = 'haircut-styles' and public.is_owner());
create policy haircut_styles_bucket_delete on storage.objects for delete
  using (bucket_id = 'haircut-styles' and public.is_owner());

create policy style_requests_bucket_write on storage.objects for insert
  with check (bucket_id = 'style-requests');
create policy style_requests_bucket_read on storage.objects for select
  using (bucket_id = 'style-requests' and public.is_owner());

select 'migration 02 applied' as result;
