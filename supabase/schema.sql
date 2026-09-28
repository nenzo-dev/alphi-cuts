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

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner');
$$;


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
  client_token text not null unique default encode(gen_random_bytes(18), 'base64url'),
  style_choice text,   -- optional: which style from the gallery they picked, e.g. 'Burst Fade'
  status text not null default 'booked'
    check (status in ('booked', 'called', 'checked_in', 'in_chair', 'done', 'no_show', 'cancelled')),
    -- booked: has a slot, not yet notified · called: the chair is about to be free, be ready now
    -- checked_in: client says they've physically arrived · in_chair: cut under way · done/no_show/cancelled: final
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
create or replace function public.get_my_booking(p_token text)
returns public.bookings
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
  where client_token = p_token and status in ('booked', 'called');
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

-- Starts the cut, and calls the next booked slot in the same move (so the room and the next
-- person's phone update in the same instant -- no separate "advance queue" click to forget).
create or replace function public.admin_start_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_date date; v_slot time;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'in_chair', started_at = now()
  where id = p_booking_id returning booking_date, slot_time into v_date, v_slot;

  update public.bookings set status = 'called', called_at = now()
  where id = (
    select id from public.bookings
    where booking_date = v_date and slot_time > v_slot and status = 'booked'
    order by slot_time limit 1
  );
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
