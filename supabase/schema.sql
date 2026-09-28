-- AlPhi Cuts (Alfred Phiri's barbershop) -- database schema.
--
-- Same pattern as MindCare: Postgres + row-level security as the real access control (never trusted
-- to the client), plus a handful of SECURITY DEFINER functions for anything that needs care --
-- looking up a stranger's booking by a private token, or letting the owner advance the queue.
-- No passwords are ever stored here: Alfred's own login uses Supabase Auth (auth.users), which this
-- schema never touches directly.
--
-- Run this once in the Supabase SQL editor on a fresh project.

create extension if not exists pgcrypto;

-- Row-level security (enabled on every table below) is the real access control, but Postgres
-- checks a plain SQL GRANT first, before RLS is even evaluated -- with "Automatically expose new
-- tables" turned off when the project was created (the more secure setting Supabase itself
-- recommends), nothing below would work at all without at least schema usage. anon/authenticated
-- get SELECT only on the two tables the client ever reads directly (site_config, profiles, granted
-- right after each is created below); bookings, feedback and chat_messages stay ungranted on
-- purpose -- every read and write to those goes through a SECURITY DEFINER function instead, which
-- runs as the function's owner regardless of these grants.
grant usage on schema public to anon, authenticated;

-- ============================================================ SITE CONFIG (one row, admin-edited)
-- Everything on the public page that Alfred should be able to change himself, without a code
-- change: contact details, hours, price, the words on the page. Editing this is the whole point of
-- the super admin panel's "Shop details" screen.
create table public.site_config (
  id smallint primary key default 1 check (id = 1),   -- singleton: exactly one row, ever
  shop_name text not null default 'AlPhi Cuts',
  tagline text not null default 'Chongwe''s best-rated barbershop',
  owner_name text not null default 'Alfred Phiri',
  address_line text not null default 'Opposite Silverest Primary School, Great East Road, Chongwe',
  directions_text text not null default
    'Coming from Great East Road: we''re the first barbershop on your left. '
    'Coming from Downlands Shopping Centre, Silverest: we''re the second barbershop on your right.',
  phone text not null default '',
  whatsapp text not null default '',
  facebook text not null default '',
  instagram text not null default '',
  about_text text not null default '',
  price_kwacha numeric(6,2) not null default 50.00,
  open_time time not null default '08:00',
  close_time time not null default '20:00',
  slot_minutes int not null default 20 check (slot_minutes > 0),
  checked_in_grace_minutes int not null default 10 check (checked_in_grace_minutes > 0),
  rating numeric(2,1) not null default 5.0 check (rating between 0 and 5),
  rating_count int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.site_config (id) values (1) on conflict (id) do nothing;

alter table public.site_config enable row level security;
create policy site_config_select_all on public.site_config for select using (true);
grant select on public.site_config to anon, authenticated;
-- No direct insert/update/delete policy for anyone: site_config is only ever changed through
-- admin_update_site_config() below, which checks the caller is really the owner first.


-- ============================================================ OWNER PROFILE
-- One row per Supabase Auth account that is allowed into the super admin panel. In practice this is
-- just Alfred, but it is a table (not a hard-coded email) so a second person could be added later
-- without a schema change.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
grant select on public.profiles to authenticated;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner');
$$;

-- Self-service setup, the same concept as MindCare's own account creation: Alfred signs up right
-- from the owner panel (supabase.auth.signUp, a normal account, no special power yet) and this is
-- what actually makes that account the owner -- but ONLY the very first person to call it after the
-- project is set up. Once one owner row exists, every later call is refused, so a stranger who
-- finds the login page can never claim the shop for themselves.
create or replace function public.claim_owner_account(p_full_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to do this.';
  end if;
  if exists (select 1 from public.profiles) then
    raise exception 'An owner account has already been set up for this shop.';
  end if;
  insert into public.profiles (id, full_name) values (auth.uid(), btrim(p_full_name));
end;
$$;
grant execute on function public.claim_owner_account(text) to authenticated;

create or replace function public.owner_account_exists()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles);
$$;
grant execute on function public.owner_account_exists() to anon, authenticated;

create or replace function public.am_i_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_owner();
$$;
grant execute on function public.am_i_owner() to authenticated;

-- Owner management ("change the owner"): an existing owner can add another Supabase Auth account
-- as a co-owner by email (that account must already exist -- ask them to use "Set up the owner
-- account" first; on a shop that already has an owner, that same form just creates a normal
-- signed-in account without granting it anything, until an existing owner adds it here), and can
-- remove one later, as long as at least one owner always remains.
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


-- ============================================================ BOOKINGS
-- Deliberately NOT readable or writable directly by anonymous clients (see the "no policy" note
-- below) -- a client only ever sees their own booking, and only because they hold the random
-- client_token handed back when they made it. That token is their ticket; losing it means losing
-- access to that booking, the same way losing a paper queue ticket would.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_date date not null,
  slot_time time not null,
  client_name text not null,
  client_phone text not null,
  client_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  style_choice text,   -- optional: which style from the gallery they picked, e.g. 'Burst Fade'
  status text not null default 'booked'
    check (status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair', 'done', 'no_show', 'cancelled')),
    -- booked: has a slot, not yet notified · on_deck: 2 people away, stick around · called: next,
    -- be ready now · checked_in: client says they've physically arrived · in_chair: cut under way
    -- done/no_show/cancelled: final
  on_deck_at timestamptz,      -- when this slot became "you're 2 away, stick around"
  called_at timestamptz,       -- when this slot became "you're up next, be ready"
  checked_in_at timestamptz,   -- when the client tapped "I'm here"
  started_at timestamptz,      -- when Alfred tapped "Start cut"
  finished_at timestamptz,     -- when Alfred tapped "Done"
  created_at timestamptz not null default now()
);
-- One booking per slot per day (cancelled/no-show slots free up for someone else to take).
create unique index bookings_slot_taken
  on public.bookings (booking_date, slot_time)
  where status not in ('cancelled', 'no_show');

alter table public.bookings enable row level security;
-- No anon policies at all here on purpose: every read and write to this table goes through a
-- function below, so a booking can never be listed, browsed or edited except through a real token
-- or as the authenticated owner.
create policy bookings_owner_all on public.bookings for all
  using (public.is_owner()) with check (public.is_owner());


-- ============================================================ FEEDBACK (ratings + comments)
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '',
  reply text,
  is_public boolean not null default false,   -- Alfred approves a review before it shows publicly
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
create policy feedback_select_public on public.feedback for select using (is_public = true);
create policy feedback_owner_all on public.feedback for all
  using (public.is_owner()) with check (public.is_owner());
-- Submitting feedback goes through submit_feedback() below (keeps rating/comment validation and
-- the is_public default in one place, and stops a client from posting straight into is_public=true).


-- ============================================================ CHAT (one thread per client_token)
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  client_token text not null,
  sender text not null check (sender in ('client', 'owner')),
  body text not null check (length(btrim(body)) > 0),
  read_by_owner boolean not null default false,
  read_by_client boolean not null default false,
  created_at timestamptz not null default now()
);
create index chat_messages_thread on public.chat_messages (client_token, created_at);

alter table public.chat_messages enable row level security;
create policy chat_owner_all on public.chat_messages for all
  using (public.is_owner()) with check (public.is_owner());


-- ============================================================ PUBLIC, NAME-FREE QUEUE VIEW
-- What the public page polls to show "3 people ahead of you" without ever exposing anyone else's
-- name or phone number.
create or replace function public.public_queue_today()
returns table (slot_time time, status text, called_at timestamptz)
language sql stable security definer set search_path = public as $$
  select slot_time, status, called_at
  from public.bookings
  where booking_date = current_date
    and status not in ('cancelled')
  order by slot_time;
$$;
grant execute on function public.public_queue_today() to anon, authenticated;


-- ============================================================ BOOKING (public)
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null
) returns text   -- returns the new client_token
language plpgsql security definer set search_path = public as $$
declare
  v_token text;
  v_open time; v_close time; v_slot_minutes int;
begin
  select open_time, close_time, slot_minutes into v_open, v_close, v_slot_minutes from public.site_config where id = 1;

  if p_date < current_date then
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
grant execute on function public.book_slot(date, time, text, text, text) to anon, authenticated;


-- ============================================================ A CLIENT'S OWN BOOKING (by token)
-- setof (not a single composite) so "no booking" comes back as an empty array, not a row of nulls
-- (a single, non-SETOF composite return always yields exactly one row -- and when the underlying
-- query matches nothing, Postgres fills that one row with nulls instead of returning "no rows").
create or replace function public.get_my_booking(p_token text)
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings where client_token = p_token;
$$;
grant execute on function public.get_my_booking(text) to anon, authenticated;

create or replace function public.cancel_my_booking(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'cancelled'
  where client_token = p_token and status in ('booked', 'checked_in');
  if not found then
    raise exception 'That booking cannot be cancelled (it may already be done or checked in).';
  end if;
end;
$$;
grant execute on function public.cancel_my_booking(text) to anon, authenticated;

-- Client self-check-in ("I'm here") when they physically arrive. This is what the QR/link at the
-- shop's door points at (see README). It does not start the cut -- only Alfred does that, from the
-- admin panel, once the chair is actually free -- but it tells him this client has really arrived.
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
grant execute on function public.check_in(text) to anon, authenticated;


-- ============================================================ FEEDBACK (public submit)
create or replace function public.submit_feedback(p_name text, p_rating int, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5.';
  end if;
  insert into public.feedback (client_name, rating, comment)
  values (nullif(btrim(p_name), ''), p_rating, coalesce(btrim(p_comment), ''));
end;
$$;
grant execute on function public.submit_feedback(text, int, text) to anon, authenticated;


-- ============================================================ CHAT (public send/read own thread)
create or replace function public.send_message(p_token text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.chat_messages (client_token, sender, body, read_by_client)
  values (p_token, 'client', btrim(p_body), true);
end;
$$;
grant execute on function public.send_message(text, text) to anon, authenticated;

create or replace function public.get_my_messages(p_token text)
returns setof public.chat_messages
language sql stable security definer set search_path = public as $$
  select * from public.chat_messages where client_token = p_token order by created_at;
$$;
grant execute on function public.get_my_messages(text) to anon, authenticated;

create or replace function public.mark_messages_read_by_client(p_token text)
returns void language sql security definer set search_path = public as $$
  update public.chat_messages set read_by_client = true
  where client_token = p_token and sender = 'owner' and read_by_client = false;
$$;
grant execute on function public.mark_messages_read_by_client(text) to anon, authenticated;


-- ============================================================ OWNER-ONLY ACTIONS
-- All guarded by is_owner() so even a stolen anon key can never call these -- only a real,
-- logged-in Alfred session can.
create or replace function public.admin_update_site_config(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.site_config set
    shop_name = coalesce(p->>'shop_name', shop_name),
    tagline = coalesce(p->>'tagline', tagline),
    owner_name = coalesce(p->>'owner_name', owner_name),
    address_line = coalesce(p->>'address_line', address_line),
    directions_text = coalesce(p->>'directions_text', directions_text),
    phone = coalesce(p->>'phone', phone),
    whatsapp = coalesce(p->>'whatsapp', whatsapp),
    facebook = coalesce(p->>'facebook', facebook),
    instagram = coalesce(p->>'instagram', instagram),
    about_text = coalesce(p->>'about_text', about_text),
    price_kwacha = coalesce((p->>'price_kwacha')::numeric, price_kwacha),
    open_time = coalesce((p->>'open_time')::time, open_time),
    close_time = coalesce((p->>'close_time')::time, close_time),
    rating = coalesce((p->>'rating')::numeric, rating),
    rating_count = coalesce((p->>'rating_count')::int, rating_count),
    updated_at = now()
  where id = 1;
end;
$$;
grant execute on function public.admin_update_site_config(jsonb) to authenticated;

create or replace function public.admin_bookings_for_date(p_date date)
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where public.is_owner() and booking_date = p_date
  order by slot_time;
$$;
grant execute on function public.admin_bookings_for_date(date) to authenticated;

-- Starts the cut, and re-alerts the next TWO people in the same move (so the room and both their
-- phones update in the same instant -- no separate "advance queue" click to forget): the very next
-- person is marked "called" (be ready now, ringing on their end), and the one after that "on_deck"
-- (stick around, you're up soon) -- both re-derived fresh every time a cut starts, so whoever was
-- on_deck correctly gets promoted to called as the queue moves.
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
grant execute on function public.admin_start_cut(uuid) to authenticated;

create or replace function public.admin_finish_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'done', finished_at = now() where id = p_booking_id;
end;
$$;
grant execute on function public.admin_finish_cut(uuid) to authenticated;

-- Frees the slot for a walk-in or another booking when a called client never showed up.
create or replace function public.admin_mark_no_show(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'no_show' where id = p_booking_id;
end;
$$;
grant execute on function public.admin_mark_no_show(uuid) to authenticated;

-- For a walk-in with no online booking: Alfred adds them straight into today's queue.
create or replace function public.admin_add_walkin(p_name text, p_phone text)
returns void language plpgsql security definer set search_path = public as $$
declare v_slot time;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select coalesce(max(slot_time), (select open_time from public.site_config where id = 1) - interval '1 minute') + interval '1 minute'
    into v_slot
    from public.bookings where booking_date = current_date and status not in ('cancelled', 'no_show');
  insert into public.bookings (booking_date, slot_time, client_name, client_phone, status)
  values (current_date, v_slot, btrim(p_name), coalesce(nullif(btrim(p_phone), ''), 'walk-in'), 'checked_in');
end;
$$;
grant execute on function public.admin_add_walkin(text, text) to authenticated;

create or replace function public.admin_list_feedback()
returns setof public.feedback
language sql stable security definer set search_path = public as $$
  select * from public.feedback where public.is_owner() order by created_at desc;
$$;
grant execute on function public.admin_list_feedback() to authenticated;

create or replace function public.admin_set_feedback_public(p_id uuid, p_public boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.feedback set is_public = p_public where id = p_id;
end;
$$;
grant execute on function public.admin_set_feedback_public(uuid, boolean) to authenticated;

create or replace function public.admin_reply_feedback(p_id uuid, p_reply text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.feedback set reply = btrim(p_reply) where id = p_id;
end;
$$;
grant execute on function public.admin_reply_feedback(uuid, text) to authenticated;

create or replace function public.admin_list_chat_threads()
returns table (client_token text, last_message text, last_at timestamptz, unread_count bigint)
language sql stable security definer set search_path = public as $$
  select client_token,
         (array_agg(body order by created_at desc))[1],
         max(created_at),
         count(*) filter (where sender = 'client' and read_by_owner = false)
  from public.chat_messages
  where public.is_owner()
  group by client_token
  order by max(created_at) desc;
$$;
grant execute on function public.admin_list_chat_threads() to authenticated;

create or replace function public.admin_reply_message(p_token text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  insert into public.chat_messages (client_token, sender, body, read_by_owner)
  values (p_token, 'owner', btrim(p_body), true);
  update public.chat_messages set read_by_owner = true where client_token = p_token and sender = 'client';
end;
$$;
grant execute on function public.admin_reply_message(text, text) to authenticated;


-- ============================================================ HAIRCUT STYLES (admin-uploadable)
-- The site launched with 36 built-in style photos bundled straight into the site (img/styles/,
-- listed in js/styles-data.js) -- those never needed a database at all. This is the part Alfred can
-- add to himself from the owner panel: new styles, with photos uploaded to Supabase Storage (the
-- "haircut-styles" bucket, created below) rather than requiring a code change and a redeploy.
create table public.haircut_styles (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create table public.haircut_style_photos (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.haircut_styles(id) on delete cascade,
  storage_path text not null,   -- path inside the "haircut-styles" Storage bucket
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.haircut_styles enable row level security;
alter table public.haircut_style_photos enable row level security;
create policy haircut_styles_select_all on public.haircut_styles for select using (true);
create policy haircut_style_photos_select_all on public.haircut_style_photos for select using (true);
grant select on public.haircut_styles, public.haircut_style_photos to anon, authenticated;
-- No direct write policy for anyone: adding/removing a style or photo always goes through the
-- admin_ functions below, which check is_owner() first.

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

-- Called after the photo file itself has already been uploaded straight to Storage from the
-- browser (supabase.storage.from('haircut-styles').upload(...)) -- this just records where it
-- landed. Storage's own upload policy (set up alongside the bucket below) is what actually checks
-- the caller is the owner; this function re-checks too, so the photo can never be recorded without it.
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


-- ============================================================ STYLE REQUESTS (public)
-- "The haircut I want isn't in the gallery" -- a client describes it and/or uploads a reference
-- photo (to the "style-requests" bucket below) so Alfred can see exactly what they mean before they
-- arrive, the same way a booking's style_choice works for gallery styles.
create table public.style_requests (
  id uuid primary key default gen_random_uuid(),
  client_token text not null,
  description text not null default '',
  storage_path text,   -- optional: a reference photo the client uploaded, in the "style-requests" bucket
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


-- ============================================================ STORAGE BUCKETS
-- "haircut-styles": Alfred's own uploads from the owner panel, public to read (so the gallery can
-- show them), owner-only to write. "style-requests": a client's own reference photo for a style
-- that isn't in the gallery, publicly *uploadable* (no login -- a client browsing the site has no
-- account) but not publicly listable, and only the owner can read them back (from the admin panel).
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

-- Defensive: Storage's own tables normally already grant these to anon/authenticated on a fresh
-- Supabase project, but re-stating them costs nothing and rules out the same class of "RLS is right
-- but the baseline GRANT is missing" bug hit earlier with the public schema.
grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;

-- Owner-only listing (mirrors list_haircut_styles but also returns each photo's id, needed so the
-- owner panel can delete one specific photo).
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

-- ============================================================ PAYMENTS (manual, owner-gated)
-- No payment gateway -- Alfred's own mobile money / bank details, shown to a client only after he
-- personally approves that specific booking for online payment, and only actually marked "paid"
-- once he says so himself after receiving the money.
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

-- Cross-date list for the owner panel's Payments tab -- bookings needing a payment decision or
-- already approved and waiting to be marked paid, regardless of which day they're booked for.
create or replace function public.admin_list_pending_payments()
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where public.is_owner() and payment_status in ('requested', 'approved')
  order by booking_date, slot_time;
$$;
grant execute on function public.admin_list_pending_payments() to authenticated;
