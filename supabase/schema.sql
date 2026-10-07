-- AlPhi Cuts database schema (v2.8.0).
--
-- Row-level security is the real access control. Anything the public can do goes through a
-- SECURITY DEFINER function below, which checks its inputs and only touches what it should: a
-- client can only see their own booking (by its private token), and every admin_ function checks
-- is_owner() first. Owner logins use Supabase Auth, so no passwords are stored in these tables.
--
-- Run this once in the Supabase SQL editor on a fresh project. An existing project should run the
-- files in supabase/migrations instead.

create extension if not exists pgcrypto;

-- With "automatically expose new tables" switched off, anon/authenticated need explicit grants.
-- They only get SELECT on the few tables the site reads directly; everything else goes through
-- the functions below.
grant usage on schema public to anon, authenticated;

-- ============================================================ SITE CONFIG (one row, owner-edited)
create table public.site_config (
  id smallint primary key default 1 check (id = 1),
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
  open_time time not null default '09:00',
  close_time time not null default '20:00',
  slot_minutes int not null default 30,
  checked_in_grace_minutes int not null default 10 check (checked_in_grace_minutes > 0),
  rating numeric(2,1) not null default 5.0 check (rating between 0 and 5),
  rating_count int not null default 0,
  booking_days_ahead int not null default 7,
  reminder_minutes int not null default 10,
  closed_weekdays int[] not null default '{}',          -- 0 = Sunday ... 6 = Saturday
  announcement text not null default '',
  content jsonb not null default '{}'::jsonb,            -- {"text": {...}, "hidden": [...], "legal": {...}}
  keep_days int not null default 90,                     -- bookings and chat older than this are deleted
  shop_lat double precision,                             -- the shop's location, for checking clients in
  shop_lng double precision,                             --   when they arrive (set in the owner panel)
  arrival_radius_m int not null default 150,             -- how close counts as arrived, in metres
  auto_checkin boolean not null default true,            -- check clients in when their phone arrives
  auto_start boolean not null default true,              -- checked-in client goes in the chair at their slot
  updated_at timestamptz not null default now(),
  constraint site_config_settings_check check (
    slot_minutes between 5 and 180
    and booking_days_ahead between 1 and 60
    and reminder_minutes between 0 and 120
    and close_time > open_time
    and closed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]
    and jsonb_typeof(content) = 'object'
  ),
  constraint site_config_keep_days_check check (keep_days between 7 and 365),
  constraint site_config_location_check check (
    (shop_lat is null) = (shop_lng is null)
    and (shop_lat is null or (shop_lat between -90 and 90 and shop_lng between -180 and 180))
    and arrival_radius_m between 30 and 1000
  )
);
insert into public.site_config (id) values (1) on conflict (id) do nothing;

alter table public.site_config enable row level security;
create policy site_config_select_all on public.site_config for select using (true);
grant select on public.site_config to anon, authenticated;
-- Only changed through admin_update_site_config().


-- ============================================================ OWNERS
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

-- ============================================================ HELPERS
-- The shop's own clock. The database runs in UTC; the shop is in Zambia (UTC+2, no DST).
create or replace function public.shop_now()
returns timestamp language sql stable as $$
  select now() at time zone 'Africa/Lusaka';
$$;

create or replace function public.shop_today()
returns date language sql stable as $$
  select (now() at time zone 'Africa/Lusaka')::date;
$$;

create or replace function public.minute_of(t time)
returns int language sql immutable as $$
  select (extract(hour from t) * 60 + extract(minute from t))::int;
$$;

-- Booking and chat tokens are random hex strings (36 chars from the database, 32 from the browser).
create or replace function public.valid_token(p text)
returns boolean language sql immutable as $$
  select coalesce(p ~ '^[0-9a-f]{32,64}$', false);
$$;
grant execute on function public.valid_token(text) to anon, authenticated;

-- The first account to call this becomes the owner. Once an owner exists it always refuses.
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

-- Add a co-owner by email (they need an account first) or remove one; one owner must remain.
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
-- Never readable directly by the public. A client sees their own booking only because they hold
-- the random client_token handed back when they booked.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_date date not null,
  slot_time time not null,
  client_name text not null,
  client_phone text not null,
  client_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  device_token text,   -- the booking device's chat token, so the owner sees a name on the chat thread
  style_choice text,
  status text not null default 'booked'
    check (status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair', 'done', 'no_show', 'cancelled')),
    -- booked -> on_deck (2 away) -> called (next) -> checked_in (says they're here) -> in_chair -> done
    -- no_show / cancelled free the slot again
  on_deck_at timestamptz,
  called_at timestamptz,
  checked_in_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  arrived_auto boolean not null default false,   -- checked in by arriving at the shop (no position is kept)
  payment_status text not null default 'none' check (payment_status in ('none', 'requested', 'approved', 'paid')),
  payment_requested_at timestamptz,
  payment_approved_at timestamptz,
  paid_at timestamptz,
  payment_expired_at timestamptz,   -- a request not approved by the slot time was cleared then
  created_at timestamptz not null default now()
);
create unique index bookings_slot_taken
  on public.bookings (booking_date, slot_time)
  where status in ('booked', 'on_deck', 'called', 'checked_in');
create index bookings_device_token on public.bookings (device_token);

alter table public.bookings enable row level security;
create policy bookings_owner_all on public.bookings for all
  using (public.is_owner()) with check (public.is_owner());

-- Minutes since midnight of the slot a booking occupies: its booked slot while waiting, or the
-- slot its cut actually started in once the barber has started it.
create or replace function public.effective_minute(p_status text, p_slot time, p_started timestamptz, p_open int, p_len int)
returns int language sql stable as $$
  select case
    when p_status in ('in_chair', 'done') and p_started is not null then
      p_open + floor((public.minute_of((p_started at time zone 'Africa/Lusaka')::time) - p_open)::numeric / p_len)::int * p_len
    else public.minute_of(p_slot)
  end;
$$;

-- Waiting bookings hold their slot; a cut in progress holds the slot it's happening in; finished,
-- cancelled and missed bookings hold nothing. Comparing start times also catches bookings made
-- when the slots were a different length.
create or replace function public.slot_is_taken(p_date date, p_slot time, p_minutes int)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.bookings b, public.site_config c
    where c.id = 1
      and b.booking_date = p_date
      and b.status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
      and abs(public.effective_minute(b.status, b.slot_time, b.started_at, public.minute_of(c.open_time), c.slot_minutes)
              - public.minute_of(p_slot)) < p_minutes
  );
$$;


-- ============================================================ FEEDBACK
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '',
  reply text,
  is_public boolean not null default false,   -- the owner publishes a review before it shows
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
create policy feedback_select_public on public.feedback for select using (is_public = true);
create policy feedback_owner_all on public.feedback for all
  using (public.is_owner()) with check (public.is_owner());


-- ============================================================ CHAT (one thread per device token)
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


-- ============================================================ PUBLIC QUEUE (no names)
create or replace function public.public_queue_today()
returns table (slot_time time, status text, called_at timestamptz)
language sql stable security definer set search_path = public as $$
  select slot_time, status, called_at
  from public.bookings
  where booking_date = public.shop_today()
    and status not in ('cancelled')
  order by slot_time;
$$;
grant execute on function public.public_queue_today() to anon, authenticated;

create or replace function public.public_queue(p_date date)
returns table (slot_time time, status text)
language sql stable security definer set search_path = public as $$
  select make_time(e.m / 60, e.m % 60, 0), e.status
  from (
    select b.status,
           public.effective_minute(b.status, b.slot_time, b.started_at, public.minute_of(c.open_time), c.slot_minutes) as m
    from public.bookings b, public.site_config c
    where c.id = 1
      and b.booking_date = p_date
      and p_date between public.shop_today() - 1 and public.shop_today() + 60
      and b.status not in ('cancelled', 'no_show')
  ) e
  order by 1;
$$;
grant execute on function public.public_queue(date) to anon, authenticated;


-- ============================================================ BOOKING (public)
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null, p_device text default null
) returns text   -- the new booking's client_token
language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_token text;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_device text := case when public.valid_token(p_device) then p_device end;
  v_start int;
begin
  select * into c from public.site_config where id = 1;

  if coalesce(c.content->'hidden', '[]'::jsonb) ? 'book' then
    raise exception 'Online booking is paused right now. Please call or visit the shop.';
  end if;
  if p_date is null or p_slot is null then
    raise exception 'Please pick a day and a time.';
  end if;
  v_start := public.minute_of(p_slot);
  if p_date < public.shop_today() then
    raise exception 'That date has already passed.';
  end if;
  if p_date > public.shop_today() + (c.booking_days_ahead - 1) then
    raise exception 'You can only book up to % days ahead.', c.booking_days_ahead;
  end if;
  if extract(dow from p_date)::int = any(c.closed_weekdays) then
    raise exception 'The shop is closed that day.';
  end if;
  if v_start < public.minute_of(c.open_time) or v_start + c.slot_minutes > public.minute_of(c.close_time) then
    raise exception 'That time is outside opening hours.';
  end if;
  if (v_start - public.minute_of(c.open_time)) % c.slot_minutes <> 0 then
    raise exception 'Please pick one of the listed times.';
  end if;
  if p_date = public.shop_today() and p_slot <= public.shop_now()::time then
    raise exception 'That time has already passed. Please pick a later one.';
  end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Please enter your name (up to 60 characters).';
  end if;
  if length(v_digits) < 9 or length(v_digits) > 15 or length(v_phone) > 20 then
    raise exception 'Please enter a valid phone number.';
  end if;
  if length(coalesce(p_style, '')) > 100 then
    raise exception 'That style name is too long.';
  end if;

  -- Bookings go through one at a time, so one person can't take two slots by booking twice at once,
  -- and two people can't take overlapping slots (walk-ins take the same lock for the day).
  perform pg_advisory_xact_lock(hashtext('book_slot'));
  perform pg_advisory_xact_lock(hashtext('book_slot:' || p_date::text));

  -- One booking at a time: the same phone number, or the same device, can't hold two.
  if exists (
    select 1 from public.bookings
    where booking_date >= public.shop_today()
      and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
      and right(regexp_replace(client_phone, '\D', '', 'g'), 9) = right(v_digits, 9)
  ) then
    raise exception 'This phone number already has a booking. You can only book one slot at a time.';
  end if;
  if v_device is not null and exists (
    select 1 from public.bookings
    where booking_date >= public.shop_today()
      and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
      and device_token = v_device
  ) then
    raise exception 'You already have a booking. You can only book one slot at a time, so cancel it first to pick another time.';
  end if;

  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''), v_device)
  returning client_token into v_token;
  return v_token;
exception
  when unique_violation then
    raise exception 'That time was just taken. Please pick another.';
end;
$$;
grant execute on function public.book_slot(date, time, text, text, text, text) to anon, authenticated;


-- ============================================================ A CLIENT'S OWN BOOKINGS (by token)
-- setof, so "not found" is an empty array rather than a row of nulls.
create or replace function public.get_my_booking(p_token text)
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings where client_token = p_token;
$$;
grant execute on function public.get_my_booking(text) to anon, authenticated;

create or replace function public.get_my_bookings(p_tokens text[])
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where client_token = any(p_tokens[1:10])
  order by booking_date, slot_time;
$$;
grant execute on function public.get_my_bookings(text[]) to anon, authenticated;

create or replace function public.cancel_my_booking(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.bookings
  where client_token = p_token
    and status in ('booked', 'on_deck', 'called', 'checked_in')
    and payment_status not in ('approved', 'paid');
  if found then return; end if;
  update public.bookings set status = 'cancelled'
  where client_token = p_token and status in ('booked', 'on_deck', 'called', 'checked_in');
  if not found then
    raise exception 'This booking can''t be cancelled any more.';
  end if;
end;
$$;
grant execute on function public.cancel_my_booking(text) to anon, authenticated;

-- "I'm here". Only the owner starts the cut; this just tells him the client has arrived.
create or replace function public.check_in(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set status = 'checked_in', checked_in_at = now()
  where client_token = p_token
    and status in ('booked', 'on_deck', 'called')
    and booking_date = public.shop_today();
  if not found then
    raise exception 'You can check in on the day of your booking, before your cut starts.';
  end if;
end;
$$;
grant execute on function public.check_in(text) to anon, authenticated;


-- ============================================================ REVIEWS (public)
create or replace function public.public_reviews()
returns table (client_name text, rating smallint, comment text, reply text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select f.client_name, f.rating, f.comment, f.reply, f.created_at
  from public.feedback f
  where f.is_public
  order by f.created_at desc
  limit 30;
$$;
grant execute on function public.public_reviews() to anon, authenticated;

create or replace function public.submit_feedback(p_name text, p_rating int, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_comment text := btrim(coalesce(p_comment, ''));
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Please choose a rating from 1 to 5 stars.';
  end if;
  if length(v_name) > 60 then
    raise exception 'Please keep your name under 60 characters.';
  end if;
  if length(v_comment) > 1000 then
    raise exception 'Please keep your review under 1000 characters.';
  end if;
  if (select count(*) from public.feedback where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'We''re getting a lot of reviews right now. Please try again later.';
  end if;
  insert into public.feedback (client_name, rating, comment)
  values (coalesce(nullif(v_name, ''), 'Anonymous'), p_rating, v_comment);
end;
$$;
grant execute on function public.submit_feedback(text, int, text) to anon, authenticated;


-- ============================================================ CHAT (public)
create or replace function public.send_message(p_token text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare v_body text := btrim(coalesce(p_body, ''));
begin
  if not public.valid_token(p_token) then
    raise exception 'Please reload the page and try again.';
  end if;
  if v_body = '' then
    raise exception 'Type a message first.';
  end if;
  if length(v_body) > 1000 then
    raise exception 'Please keep messages under 1000 characters.';
  end if;
  if (select count(*) from public.chat_messages
      where client_token = p_token and sender = 'client' and created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'You''re sending messages too quickly. Please wait a few minutes.';
  end if;
  insert into public.chat_messages (client_token, sender, body, read_by_client)
  values (p_token, 'client', v_body, true);
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
create or replace function public.admin_update_site_config(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c public.site_config;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save.'; end if;
  select * into c from public.site_config where id = 1 for update;

  if p ? 'shop_name' then c.shop_name := btrim(p->>'shop_name'); end if;
  if p ? 'tagline' then c.tagline := btrim(p->>'tagline'); end if;
  if p ? 'owner_name' then c.owner_name := btrim(p->>'owner_name'); end if;
  if p ? 'address_line' then c.address_line := btrim(p->>'address_line'); end if;
  if p ? 'directions_text' then c.directions_text := btrim(p->>'directions_text'); end if;
  if p ? 'about_text' then c.about_text := btrim(p->>'about_text'); end if;
  if p ? 'phone' then c.phone := btrim(p->>'phone'); end if;
  if p ? 'whatsapp' then c.whatsapp := btrim(p->>'whatsapp'); end if;
  if p ? 'facebook' then c.facebook := btrim(p->>'facebook'); end if;
  if p ? 'instagram' then c.instagram := btrim(p->>'instagram'); end if;
  if p ? 'announcement' then c.announcement := btrim(p->>'announcement'); end if;
  if nullif(p->>'price_kwacha', '') is not null then c.price_kwacha := (p->>'price_kwacha')::numeric; end if;
  if nullif(p->>'rating', '') is not null then c.rating := (p->>'rating')::numeric; end if;
  if nullif(p->>'rating_count', '') is not null then c.rating_count := (p->>'rating_count')::int; end if;
  if nullif(p->>'open_time', '') is not null then c.open_time := (p->>'open_time')::time; end if;
  if nullif(p->>'close_time', '') is not null then c.close_time := (p->>'close_time')::time; end if;
  if nullif(p->>'slot_minutes', '') is not null then c.slot_minutes := (p->>'slot_minutes')::int; end if;
  if nullif(p->>'booking_days_ahead', '') is not null then c.booking_days_ahead := (p->>'booking_days_ahead')::int; end if;
  if nullif(p->>'reminder_minutes', '') is not null then c.reminder_minutes := (p->>'reminder_minutes')::int; end if;
  if nullif(p->>'keep_days', '') is not null then c.keep_days := (p->>'keep_days')::int; end if;
  if jsonb_typeof(p->'closed_weekdays') = 'array' then
    c.closed_weekdays := array(select distinct x::int from jsonb_array_elements_text(p->'closed_weekdays') x order by 1);
  end if;
  if p ? 'content' then
    if jsonb_typeof(p->'content') <> 'object' then raise exception 'Nothing to save.'; end if;
    c.content := c.content || (p->'content');
  end if;

  if c.shop_name = '' or length(c.shop_name) > 60 then raise exception 'The shop name must be 1 to 60 characters.'; end if;
  if c.owner_name = '' or length(c.owner_name) > 60 then raise exception 'The owner name must be 1 to 60 characters.'; end if;
  if length(c.tagline) > 160 then raise exception 'Please keep the tagline under 160 characters.'; end if;
  if length(c.address_line) > 200 or length(c.directions_text) > 1000 or length(c.about_text) > 2000 then
    raise exception 'The address, directions or about text is too long.';
  end if;
  if length(c.phone) > 30 or length(c.whatsapp) > 30 then raise exception 'Phone numbers must be under 30 characters.'; end if;
  if (c.facebook <> '' and c.facebook !~* '^https://') or (c.instagram <> '' and c.instagram !~* '^https://')
     or length(c.facebook) > 300 or length(c.instagram) > 300 then
    raise exception 'Facebook and Instagram links must start with https://';
  end if;
  if length(c.announcement) > 300 then raise exception 'Please keep the announcement under 300 characters.'; end if;
  if c.price_kwacha < 0 or c.price_kwacha > 100000 then raise exception 'Please enter a sensible price.'; end if;
  if c.rating < 0 or c.rating > 5 then raise exception 'The rating must be between 0 and 5.'; end if;
  if c.rating_count < 0 then raise exception 'The review count can''t be negative.'; end if;
  if c.close_time <= c.open_time then raise exception 'Closing time must be after opening time.'; end if;
  if c.slot_minutes < 5 or c.slot_minutes > 180 then raise exception 'Slot length must be between 5 and 180 minutes.'; end if;
  if public.minute_of(c.close_time) - public.minute_of(c.open_time) < c.slot_minutes then
    raise exception 'The opening hours are shorter than one slot.';
  end if;
  if c.booking_days_ahead < 1 or c.booking_days_ahead > 60 then raise exception 'Booking window must be 1 to 60 days.'; end if;
  if c.reminder_minutes < 0 or c.reminder_minutes > 120 then raise exception 'The reminder must be 0 to 120 minutes before.'; end if;
  if c.keep_days < 7 or c.keep_days > 365 then raise exception 'Records must be kept for 7 to 365 days.'; end if;
  if not (c.closed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]) or cardinality(c.closed_weekdays) >= 7 then
    raise exception 'The shop needs at least one open day.';
  end if;
  if pg_column_size(c.content) > 200000 then raise exception 'That''s too much text to save at once.'; end if;

  update public.site_config set
    shop_name = c.shop_name, tagline = c.tagline, owner_name = c.owner_name,
    address_line = c.address_line, directions_text = c.directions_text, about_text = c.about_text,
    phone = c.phone, whatsapp = c.whatsapp, facebook = c.facebook, instagram = c.instagram,
    announcement = c.announcement, price_kwacha = c.price_kwacha,
    rating = c.rating, rating_count = c.rating_count,
    open_time = c.open_time, close_time = c.close_time, slot_minutes = c.slot_minutes,
    booking_days_ahead = c.booking_days_ahead, reminder_minutes = c.reminder_minutes,
    keep_days = c.keep_days, closed_weekdays = c.closed_weekdays, content = c.content,
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

-- One chair: starting a cut finishes whoever was still marked as in the chair, then alerts the next
-- two people (the next one is "called", the one after is "on deck"). Shared by the owner's "Start
-- cut" and the automatic start (auto_start_due); false when that booking can't be started.
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
grant execute on function public.admin_start_cut(uuid) to authenticated;

-- ============================================================ ARRIVING (2.5.0)
-- A client who turns on "Check me in when I arrive" has their phone compare its position with the
-- shop's on the day of the booking; inside the arrival distance it calls arrive_at_shop(), which
-- checks the distance again here. The position itself is never stored, only arrived_auto.
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

-- Every minute (pg_cron, below): the next checked-in client whose slot has started goes into the
-- chair, if the chair is free, or if the cut in it has run for more than two slots (left running
-- by mistake). Answers how many cuts it started (0 or 1).
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

create or replace function public.admin_finish_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'done', finished_at = now()
  where id = p_booking_id and status = 'in_chair';
  if not found then raise exception 'That cut isn''t in progress. Refresh the list and try again.'; end if;
end;
$$;
grant execute on function public.admin_finish_cut(uuid) to authenticated;

create or replace function public.admin_mark_no_show(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'no_show'
  where id = p_booking_id and status in ('booked', 'on_deck', 'called');
  if not found then raise exception 'That booking can''t be marked as a no-show. Refresh the list and try again.'; end if;
end;
$$;
grant execute on function public.admin_mark_no_show(uuid) to authenticated;

create or replace function public.admin_cancel_booking(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.bookings
  where id = p_booking_id
    and status in ('booked', 'on_deck', 'called', 'checked_in')
    and payment_status not in ('approved', 'paid');
  if found then return; end if;
  update public.bookings set status = 'cancelled'
  where id = p_booking_id and status in ('booked', 'on_deck', 'called', 'checked_in');
  if not found then raise exception 'That booking can''t be cancelled. Refresh the list and try again.'; end if;
end;
$$;
grant execute on function public.admin_cancel_booking(uuid) to authenticated;

-- A walk-in gets the earliest free slot that hasn't finished yet.
create or replace function public.admin_add_walkin(p_name text, p_phone text)
returns time language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  v_today date := public.shop_today();
  v_now int := public.minute_of(public.shop_now()::time);
  v_name text := btrim(coalesce(p_name, ''));
  v_t int;
  v_slot time;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Enter the walk-in''s name (up to 60 characters).';
  end if;
  select * into c from public.site_config where id = 1;
  perform pg_advisory_xact_lock(hashtext('book_slot:' || v_today::text));

  v_t := public.minute_of(c.open_time);
  while v_t + c.slot_minutes <= public.minute_of(c.close_time) loop
    if v_t + c.slot_minutes > v_now then
      v_slot := make_time(v_t / 60, v_t % 60, 0);
      if not public.slot_is_taken(v_today, v_slot, c.slot_minutes) then
        insert into public.bookings (booking_date, slot_time, client_name, client_phone, status, checked_in_at)
        values (v_today, v_slot, v_name, coalesce(nullif(btrim(p_phone), ''), 'walk-in'), 'checked_in', now());
        return v_slot;
      end if;
    end if;
    v_t := v_t + c.slot_minutes;
  end loop;
  raise exception 'There are no free slots left today.';
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

create or replace function public.admin_delete_feedback(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.feedback where id = p_id;
end;
$$;
grant execute on function public.admin_delete_feedback(uuid) to authenticated;

create or replace function public.admin_list_chat_threads()
returns table (client_token text, client_name text, last_message text, last_at timestamptz, unread_count bigint)
language sql stable security definer set search_path = public as $$
  select m.client_token,
         (select b.client_name from public.bookings b
            where b.client_token = m.client_token or b.device_token = m.client_token
            order by b.created_at desc limit 1),
         (array_agg(m.body order by m.created_at desc))[1],
         max(m.created_at),
         count(*) filter (where m.sender = 'client' and not m.read_by_owner)
  from public.chat_messages m
  where public.is_owner()
  group by m.client_token
  order by max(m.created_at) desc;
$$;
grant execute on function public.admin_list_chat_threads() to authenticated;

create or replace function public.admin_mark_thread_read(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.chat_messages set read_by_owner = true
  where client_token = p_token and sender = 'client' and not read_by_owner;
end;
$$;
grant execute on function public.admin_mark_thread_read(text) to authenticated;

create or replace function public.admin_reply_message(p_token text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare v_body text := btrim(coalesce(p_body, ''));
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  if v_body = '' or length(v_body) > 2000 then
    raise exception 'Replies must be between 1 and 2000 characters.';
  end if;
  insert into public.chat_messages (client_token, sender, body, read_by_owner)
  values (p_token, 'owner', v_body, true);
  update public.chat_messages set read_by_owner = true where client_token = p_token and sender = 'client';
end;
$$;
grant execute on function public.admin_reply_message(text, text) to authenticated;


-- ============================================================ HAIRCUT STYLES (owner uploads)
-- The built-in gallery lives in img/styles/ (js/styles-data.js). These are extra styles the owner
-- adds from the panel, with photos in the "haircut-styles" storage bucket.
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


-- ============================================================ STYLE REQUESTS (public)
-- "The style I want isn't in the gallery": a description and/or a reference photo in the
-- private "style-requests" bucket.
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
declare v_desc text := btrim(coalesce(p_description, ''));
begin
  if not public.valid_token(p_token) then
    raise exception 'Please reload the page and try again.';
  end if;
  if p_storage_path is not null
     and (left(p_storage_path, length(p_token) + 1) <> (p_token || '/') or length(p_storage_path) > 200) then
    raise exception 'Please reload the page and try again.';
  end if;
  if v_desc = '' and p_storage_path is null then
    raise exception 'Describe the style or add a photo of it.';
  end if;
  if length(v_desc) > 500 then
    raise exception 'Please keep the description under 500 characters.';
  end if;
  if (select count(*) from public.style_requests
      where client_token = p_token and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You''ve sent a few requests already. Please wait a while before sending more.';
  end if;
  insert into public.style_requests (client_token, description, storage_path)
  values (p_token, v_desc, p_storage_path);
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

-- Style requests (with a photo) that are past keep_days, for the owner panel to delete: the photo
-- has to be removed through the Storage API, so the database only lists which ones are due.
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


-- ============================================================ STORAGE
-- "haircut-styles": public to read, owner-only to write. "style-requests": anyone can upload into
-- a folder named after their own token, only the owner can read or delete. Images only, 5 MB max.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('haircut-styles', 'haircut-styles', true, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']),
  ('style-requests', 'style-requests', false, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

create policy haircut_styles_bucket_read on storage.objects for select
  using (bucket_id = 'haircut-styles');
create policy haircut_styles_bucket_write on storage.objects for insert
  with check (bucket_id = 'haircut-styles' and public.is_owner());
create policy haircut_styles_bucket_delete on storage.objects for delete
  using (bucket_id = 'haircut-styles' and public.is_owner());

create policy style_requests_bucket_write on storage.objects for insert
  with check (bucket_id = 'style-requests' and public.valid_token(split_part(name, '/', 1)));
create policy style_requests_bucket_read on storage.objects for select
  using (bucket_id = 'style-requests' and public.is_owner());
create policy style_requests_bucket_delete on storage.objects for delete
  using (bucket_id = 'style-requests' and public.is_owner());

grant usage on schema storage to anon, authenticated;
grant select, insert on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;


-- ============================================================ PAYMENTS (manual, owner-approved)
-- No payment gateway. The owner's mobile money / bank details are shown to a client only after he
-- approves that booking, and a booking is only marked paid once he confirms the money arrived.
create table public.payment_config (
  id int primary key default 1 check (id = 1),
  instructions text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.payment_config (id) values (1) on conflict (id) do nothing;
alter table public.payment_config enable row level security;
create policy payment_config_owner_all on public.payment_config for all
  using (public.is_owner()) with check (public.is_owner());

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

create or replace function public.request_online_payment(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings
  set payment_status = 'requested', payment_requested_at = now(), payment_expired_at = null
  where client_token = p_token
    and payment_status = 'none'
    and status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair')
    and booking_date + slot_time > public.shop_now();
  if found then return; end if;
  if exists (
    select 1 from public.bookings
    where client_token = p_token and payment_status = 'none' and booking_date + slot_time <= public.shop_now()
  ) then
    raise exception 'Your slot has already started, so you can''t ask to pay online now. Please pay at the shop.';
  end if;
  raise exception 'Online payment can''t be requested for this booking right now.';
end;
$$;
grant execute on function public.request_online_payment(text) to anon, authenticated;

create or replace function public.admin_approve_payment(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_instructions text;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select instructions into v_instructions from public.payment_config where id = 1;
  if coalesce(btrim(v_instructions), '') = '' then
    raise exception 'Save your payment details at the top of this page first.';
  end if;
  update public.bookings set payment_status = 'approved', payment_approved_at = now()
  where id = p_booking_id and payment_status in ('none', 'requested');
  if not found then raise exception 'This booking cannot be approved for online payment right now.'; end if;
end;
$$;
grant execute on function public.admin_approve_payment(uuid) to authenticated;

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

-- The instructions are only included once this exact booking has been approved (or paid).
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

create or replace function public.admin_list_pending_payments()
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where public.is_owner() and payment_status in ('requested', 'approved')
  order by booking_date, slot_time;
$$;
grant execute on function public.admin_list_pending_payments() to authenticated;


-- ============================================================ AUTOMATIC CLEANUP
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
  delete from public.push_outbox where created_at < now() - interval '2 days';
  delete from public.push_subscriptions where owner_id is null and updated_at < now() - make_interval(days => v_keep);
  update public.push_subscriptions s
    set booking_tokens = coalesce(array(select t from unnest(s.booking_tokens) t
                                        where exists (select 1 from public.bookings b where b.client_token = t)), '{}')
    where s.booking_tokens <> '{}';
end;
$$;
revoke execute on function public.cleanup_old_records() from public, anon, authenticated;

create or replace function public.admin_run_cleanup()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  perform public.cleanup_old_records();
end;
$$;
grant execute on function public.admin_run_cleanup() to authenticated;

-- Every 10 minutes, if pg_cron is available on this project.
do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-cleanup';
  perform cron.schedule('alphicuts-cleanup', '*/10 * * * *', 'select public.cleanup_old_records()');
exception when others then
  raise notice 'pg_cron is not available (%); the owner panel runs the cleanup instead.', sqlerrm;
end
$cron$;

-- Every minute: checked-in clients go into the chair when their slot starts (auto_start_due).
do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-autostart';
  perform cron.schedule('alphicuts-autostart', '* * * * *', 'select public.auto_start_due()');
exception when others then
  raise notice 'pg_cron is not available (%); cuts are only started from the owner panel.', sqlerrm;
end
$cron$;

-- ============================================================ NOTIFICATIONS (2.7.0, Web Push)
-- See supabase/migrations/13_push_notifications.sql for how the pieces fit together, and
-- supabase/functions/push-send for the function that sends them.
-- ------------------------------------------------------------ tables (no direct access for visitors)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  device_token text,                                   -- this device's chat thread
  booking_tokens text[] not null default '{}',         -- the bookings made on this device
  owner_id uuid references auth.users(id) on delete set null,  -- set when the owner turns them on
  free_on date,                                        -- "tell me when the barber is free" for this day
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_check check (
    length(endpoint) <= 1000
    and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
    and p256dh ~ '^[A-Za-z0-9_-]{80,100}$'
    and auth ~ '^[A-Za-z0-9_-]{16,30}$'
    and coalesce(array_length(booking_tokens, 1), 0) <= 10
  )
);
create index if not exists push_subscriptions_device on public.push_subscriptions (device_token);
create index if not exists push_subscriptions_bookings on public.push_subscriptions using gin (booking_tokens);
alter table public.push_subscriptions enable row level security;

create table if not exists public.push_outbox (
  id bigint generated always as identity primary key,
  target text not null check (target in ('booking', 'device', 'owners', 'free', 'endpoint')),
  token text not null,          -- a booking token, a chat token, 'owners', a date (free) or an endpoint
  title text not null,
  body text not null,
  url text not null default './#book',
  tag text not null default 'alphi-cuts',
  urgent boolean not null default false,
  dedupe text unique,           -- the same event is only ever queued once
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists push_outbox_waiting on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox enable row level security;

-- The keys the push-send function signs with. Made by the function itself the first time it runs.
create table if not exists public.push_keys (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,     -- base64url, given to browsers when they subscribe
  private_jwk jsonb not null,   -- only ever read by push-send, through push_keys_get()
  created_at timestamptz not null default now()
);
alter table public.push_keys enable row level security;

-- Where the database calls push-send so new notifications go out within seconds (the every-minute
-- run covers anything this misses). Filled in below for this project; empty means "wait for cron".
create table if not exists public.push_settings (
  id smallint primary key default 1 check (id = 1),
  function_url text,
  anon_key text,
  free_was_busy boolean,        -- whether the chair was busy at the last check, for "free now"
  free_day date
);
insert into public.push_settings (id) values (1) on conflict (id) do nothing;
alter table public.push_settings enable row level security;

revoke all on public.push_subscriptions, public.push_outbox, public.push_keys, public.push_settings from anon, authenticated;

-- ============================================================ WORDING
-- Times and days the way the site writes them: 5pm, 5:30pm; today, tomorrow, Mon 12 Oct.
create or replace function public.push_time(t time)
returns text language sql immutable as $$
  select case when t is null then '' else
    (case when extract(hour from t)::int % 12 = 0 then 12 else extract(hour from t)::int % 12 end)::text
    || case when extract(minute from t)::int = 0 then '' else ':' || to_char(t, 'MI') end
    || case when extract(hour from t)::int < 12 then 'am' else 'pm' end
  end;
$$;

create or replace function public.push_day(d date)
returns text language sql stable as $$
  select case
    when d = public.shop_today() then 'today'
    when d = public.shop_today() + 1 then 'tomorrow'
    else trim(to_char(d, 'Dy')) || ' ' || extract(day from d)::int || ' ' || trim(to_char(d, 'Mon'))
  end;
$$;

-- The owner's wording for a message if they've changed it in the owner panel, otherwise ours, with
-- {shop}, {owner}, {owner_first}, {time} and {mins} filled in (as js/lib/content.js does).
create or replace function public.push_text(p_key text, p_default text, p_time time default null, p_mins int default null)
returns text language sql stable security definer set search_path = public as $$
  select replace(replace(replace(replace(replace(replace(
      coalesce(nullif(btrim(c.content -> 'text' ->> p_key), ''), p_default),
      '{shop}', btrim(c.shop_name)),
      '{owner_first}', split_part(btrim(c.owner_name), ' ', 1)),
      '{owner}', btrim(c.owner_name)),
      '{time}', public.push_time(p_time)),
      '{mins}', coalesce(p_mins::text, '')),
      ' 1 minutes', ' 1 minute')
  from public.site_config c where c.id = 1;
$$;

-- ============================================================ QUEUEING
-- Asks push-send to run now (through pg_net, which doesn't wait for the answer). If pg_net isn't
-- there, or the address isn't set, the every-minute run sends the notification instead.
create or replace function public.push_kick()
returns void language plpgsql security definer set search_path = public as $$
declare s public.push_settings;
begin
  select * into s from public.push_settings where id = 1;
  if s.function_url is null or s.anon_key is null then return; end if;
  perform net.http_post(
    url := s.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || s.anon_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000);
exception when others then
  null;
end;
$$;
revoke all on function public.push_kick() from public, anon, authenticated;

create or replace function public.push_queue(
  p_target text, p_token text, p_title text, p_body text, p_url text, p_tag text, p_urgent boolean, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or coalesce(btrim(p_body), '') = '' then return; end if;
  insert into public.push_outbox (target, token, title, body, url, tag, urgent, dedupe)
  values (p_target, p_token, left(p_title, 120), left(p_body, 300), coalesce(p_url, './#book'), coalesce(p_tag, 'alphi-cuts'), coalesce(p_urgent, false), p_dedupe)
  on conflict (dedupe) do nothing;
  if found then perform public.push_kick(); end if;
end;
$$;
revoke all on function public.push_queue(text, text, text, text, text, text, boolean, text) from public, anon, authenticated;

-- ============================================================ WHAT TRIGGERS A NOTIFICATION
-- Bookings: a new booking, a cancellation, check-ins and payment requests go to the owner; being two
-- away, being called next, a cancellation by the shop and an approved online payment go to the client.
create or replace function public.push_on_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner boolean := public.is_owner();
  v_shop text;
  v_when text;
begin
  select btrim(shop_name) into v_shop from public.site_config where id = 1;

  if tg_op = 'DELETE' then
    if old.status not in ('booked', 'on_deck', 'called', 'checked_in') or old.booking_date < public.shop_today() then return old; end if;
    v_when := public.push_time(old.slot_time) || ' ' || public.push_day(old.booking_date);
    if v_owner then
      perform public.push_queue('booking', old.client_token, 'Booking cancelled',
        'Your booking for ' || v_when || ' at ' || v_shop || ' was cancelled by the shop. You can book another slot any time.',
        './#book', 'booking-' || old.client_token, false, 'cancel:' || old.id);
    else
      perform public.push_queue('owners', 'owners', 'Booking cancelled',
        old.client_name || ' cancelled their booking for ' || v_when || '.', './admin#bookings', 'owner-booking', false, 'cancel:' || old.id);
    end if;
    return old;
  end if;

  v_when := public.push_time(new.slot_time) || ' ' || public.push_day(new.booking_date);

  if tg_op = 'INSERT' then
    if not v_owner then
      perform public.push_queue('owners', 'owners', 'New booking',
        new.client_name || ', ' || v_when || coalesce(' (' || nullif(btrim(new.style_choice), '') || ')', '') || '.',
        './admin#bookings', 'owner-booking', false, 'new:' || new.id);
    end if;
    return new;
  end if;

  -- UPDATE
  if new.status is distinct from old.status then
    if new.status = 'on_deck' then
      perform public.push_queue('booking', new.client_token, 'Almost your turn',
        public.push_text('alert_on_deck', 'You''re 2 away at {shop}. Start heading over.', new.slot_time),
        './#book', 'booking-' || new.client_token, false, 'on_deck:' || new.id);
    elsif new.status = 'called' then
      perform public.push_queue('booking', new.client_token, 'You''re next',
        public.push_text('alert_called', 'You''re next at {shop}. Please be at the shop now.', new.slot_time),
        './#book', 'booking-' || new.client_token, true, 'called:' || new.id);
    elsif new.status = 'checked_in' then
      if new.arrived_auto then
        perform public.push_queue('booking', new.client_token, v_shop,
          public.push_text('alert_arrived', 'You''re checked in at {shop}. {owner_first} can see you''re here.', new.slot_time),
          './#book', 'arrived', false, 'arrived:' || new.id);
      end if;
      if not v_owner then
        perform public.push_queue('owners', 'owners', 'Client here',
          new.client_name || ' is here for ' || public.push_time(new.slot_time) || '.', './admin#queue', 'owner-here', false, 'here:' || new.id);
      end if;
    elsif new.status = 'cancelled' then
      if v_owner then
        perform public.push_queue('booking', new.client_token, 'Booking cancelled',
          'Your booking for ' || v_when || ' at ' || v_shop || ' was cancelled by the shop.',
          './#book', 'booking-' || new.client_token, false, 'cancel:' || new.id);
      else
        perform public.push_queue('owners', 'owners', 'Booking cancelled',
          new.client_name || ' cancelled their booking for ' || v_when || '.', './admin#bookings', 'owner-booking', false, 'cancel:' || new.id);
      end if;
    end if;
  end if;

  if new.payment_status is distinct from old.payment_status then
    if new.payment_status = 'requested' then
      perform public.push_queue('owners', 'owners', 'Online payment request',
        new.client_name || ' would like to pay online for ' || v_when || '.', './admin#payments', 'owner-payment', false, 'payreq:' || new.id);
    elsif new.payment_status = 'approved' then
      perform public.push_queue('booking', new.client_token, 'You can pay online',
        'Your online payment for ' || v_when || ' is approved. Open your booking to see how to pay.',
        './#book', 'pay-' || new.client_token, false, 'payok:' || new.id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.push_on_booking() from public, anon, authenticated;
drop trigger if exists push_bookings on public.bookings;
create trigger push_bookings after insert or update or delete on public.bookings
  for each row execute function public.push_on_booking();

-- Chat: the barber's replies go to the client's device; clients' messages go to the owner.
create or replace function public.push_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if new.sender = 'owner' then
    perform public.push_queue('device', new.client_token,
      'Message from ' || (select split_part(btrim(owner_name), ' ', 1) from public.site_config where id = 1),
      left(new.body, 160), './#chat', 'chat', false, 'msg:' || new.id);
  else
    select client_name into v_name from public.bookings where device_token = new.client_token order by created_at desc limit 1;
    perform public.push_queue('owners', 'owners', 'Message from ' || coalesce(v_name, 'a client'),
      left(new.body, 160), './admin#chat', 'owner-chat', false, 'msg:' || new.id);
  end if;
  return new;
end;
$$;
revoke all on function public.push_on_message() from public, anon, authenticated;
drop trigger if exists push_chat on public.chat_messages;
create trigger push_chat after insert on public.chat_messages
  for each row execute function public.push_on_message();

create or replace function public.push_on_style_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.push_queue('owners', 'owners', 'New style request',
    coalesce(nullif(left(btrim(new.description), 140), ''), 'A client sent a photo of a style.'),
    './admin#requests', 'owner-style', false, 'style:' || new.id);
  return new;
end;
$$;
revoke all on function public.push_on_style_request() from public, anon, authenticated;
drop trigger if exists push_style_requests on public.style_requests;
create trigger push_style_requests after insert on public.style_requests
  for each row execute function public.push_on_style_request();

create or replace function public.push_on_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.push_queue('owners', 'owners', 'New review: ' || new.rating || ' of 5',
    coalesce(nullif(left(btrim(new.comment), 140), ''), new.client_name || ' left a rating.'),
    './admin#feedback', 'owner-review', false, 'review:' || new.id);
  return new;
end;
$$;
revoke all on function public.push_on_feedback() from public, anon, authenticated;
drop trigger if exists push_feedback on public.feedback;
create trigger push_feedback after insert on public.feedback
  for each row execute function public.push_on_feedback();

-- Every minute: the heads-up before a slot, "it's your turn" when the slot starts, "you're next"
-- for a client already at the shop, and "the barber is free" for anyone who asked today.
create or replace function public.push_due()
returns int language plpgsql security definer set search_path = public as $$
declare
  c public.site_config;
  s public.push_settings;
  v_today date := public.shop_today();
  v_now int := public.minute_of(public.shop_now()::time);
  v_open boolean;
  v_busy boolean;
  v_count int := 0;
  b record;
begin
  select * into c from public.site_config where id = 1;
  if c.closed_weekdays @> array[extract(dow from v_today)::int] then return 0; end if;

  for b in
    select id, client_token, slot_time, status, public.minute_of(slot_time) as m
    from public.bookings
    where booking_date = v_today and status in ('booked', 'on_deck', 'called', 'checked_in')
  loop
    if b.status <> 'checked_in' and v_now >= b.m and v_now < b.m + c.slot_minutes then
      perform public.push_queue('booking', b.client_token, 'It''s your turn',
        public.push_text('alert_now', 'It''s your turn at {shop}. Please go to the chair now.', b.slot_time),
        './#book', 'booking-' || b.client_token, true, 'due:' || b.id);
      v_count := v_count + 1;
    elsif b.status in ('booked', 'on_deck') and c.reminder_minutes > 0 and v_now < b.m and v_now >= b.m - c.reminder_minutes then
      perform public.push_queue('booking', b.client_token, 'Your cut is coming up',
        public.push_text('alert_reminder', 'Your cut at {shop} starts in {mins} minutes.', b.slot_time, b.m - v_now),
        './#book', 'booking-' || b.client_token, false, 'reminder:' || b.id);
      v_count := v_count + 1;
    elsif b.status = 'checked_in' and not exists (
      select 1 from public.bookings x
      where x.booking_date = v_today and x.id <> b.id
        and x.status in ('booked', 'on_deck', 'called', 'checked_in')
        and public.minute_of(x.slot_time) < b.m
    ) then
      perform public.push_queue('booking', b.client_token, 'You''re next',
        public.push_text('alert_next_here', 'You''re next at {shop}. Please don''t leave. {owner_first} will call you to the chair shortly.', b.slot_time),
        './#book', 'next-' || b.client_token, false, 'next:' || b.id);
      v_count := v_count + 1;
    end if;
  end loop;

  -- "Free now": the chair has just become free while the shop is open.
  v_open := v_now >= public.minute_of(c.open_time) and v_now < public.minute_of(c.close_time);
  v_busy := exists (
    select 1 from public.bookings
    where booking_date = v_today
      and (status = 'in_chair'
        or (status in ('booked', 'on_deck', 'called', 'checked_in') and abs(public.minute_of(slot_time) - v_now) < c.slot_minutes and public.minute_of(slot_time) <= v_now)));
  select * into s from public.push_settings where id = 1;
  if v_open and not v_busy and s.free_day = v_today and s.free_was_busy then
    perform public.push_queue('free', v_today::text, btrim(c.shop_name) || ' is free now',
      public.push_text('queue_free_banner', '{owner_first} is free right now. Walk in or book a slot.'),
      './#book', 'shop-free', false, 'free:' || v_today || ':' || v_now);
    v_count := v_count + 1;
  end if;
  update public.push_settings set free_was_busy = v_busy or not v_open, free_day = v_today where id = 1;
  return v_count;
end;
$$;
revoke all on function public.push_due() from public, anon, authenticated;

-- Every minute: requests still waiting for approval when the slot starts are cleared, and the client
-- is told (if they turned notifications on; the booking on the page says so too).
create or replace function public.expire_payment_requests()
returns int language plpgsql security definer set search_path = public as $$
declare
  b record;
  v_count int := 0;
begin
  for b in
    update public.bookings
    set payment_status = 'none', payment_requested_at = null, payment_expired_at = now()
    where payment_status = 'requested' and booking_date + slot_time <= public.shop_now()
    returning id, client_token, booking_date, slot_time, status
  loop
    v_count := v_count + 1;
    if b.booking_date = public.shop_today() and b.status in ('booked', 'on_deck', 'called', 'checked_in', 'in_chair') then
      perform public.push_queue('booking', b.client_token, 'Online payment request cleared',
        public.push_text('pay_expired', 'Your request to pay online wasn''t approved before your slot, so it was cleared. Please pay at the shop.', b.slot_time),
        './#book', 'pay-' || b.client_token, false, 'payexp:' || b.id);
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.expire_payment_requests() from public, anon, authenticated;

do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-payments';
  perform cron.schedule('alphicuts-payments', '* * * * *', 'select public.expire_payment_requests()');
exception when others then
  raise notice 'pg_cron is not available (%); payment requests are not cleared automatically.', sqlerrm;
end
$cron$;

-- ============================================================ FOR THE PUSH-SEND FUNCTION ONLY
create or replace function public.push_keys_get()
returns table (public_key text, private_jwk jsonb)
language sql stable security definer set search_path = public as $$
  select public_key, private_jwk from public.push_keys where id = 1;
$$;

create or replace function public.push_keys_init(p_public_key text, p_private_jwk jsonb)
returns table (public_key text, private_jwk jsonb)
language plpgsql security definer set search_path = public as $$
begin
  insert into public.push_keys (id, public_key, private_jwk) values (1, p_public_key, p_private_jwk)
  on conflict (id) do nothing;
  return query select k.public_key, k.private_jwk from public.push_keys k where k.id = 1;
end;
$$;

-- Takes the waiting notifications (each one only once, even if two runs overlap) and answers one row
-- per device to send it to. Ones that waited more than 30 minutes are dropped: they'd arrive too late.
create or replace function public.push_take(p_limit int default 200)
returns table (outbox_id bigint, endpoint text, p256dh text, auth text, title text, body text, url text, tag text, urgent boolean)
language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  update public.push_outbox set sent_at = now() where sent_at is null and created_at < now() - interval '30 minutes';
  select array_agg(id) into v_ids from (
    select id from public.push_outbox where sent_at is null order by id limit p_limit for update skip locked
  ) w;
  if v_ids is null then return; end if;
  update public.push_outbox set sent_at = now() where id = any(v_ids);

  return query
    select o.id, s.endpoint, s.p256dh, s.auth, o.title, o.body, o.url, o.tag, o.urgent
    from public.push_outbox o
    join public.push_subscriptions s on (
         (o.target = 'booking' and o.token = any(s.booking_tokens))
      or (o.target = 'device' and s.device_token = o.token)
      or (o.target = 'owners' and s.owner_id is not null and exists (select 1 from public.profiles p where p.id = s.owner_id and p.role = 'owner'))
      or (o.target = 'free' and s.free_on = o.token::date)
      or (o.target = 'endpoint' and s.endpoint = o.token))
    where o.id = any(v_ids)
    order by o.id;

  -- "Tell me when the barber is free" is a one-off: once told, it's done for the day.
  update public.push_subscriptions s set free_on = null
  from public.push_outbox o
  where o.id = any(v_ids) and o.target = 'free' and s.free_on = o.token::date;
end;
$$;

-- Push services answer 404 or 410 for a device that has turned notifications off or gone away.
create or replace function public.push_forget(p_endpoints text[])
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = any(p_endpoints);
$$;

revoke all on function public.push_keys_get(), public.push_keys_init(text, jsonb), public.push_take(int),
  public.push_forget(text[]) from public, anon, authenticated;
do $grants$
begin
  grant execute on function public.push_keys_get(), public.push_keys_init(text, jsonb), public.push_take(int),
    public.push_forget(text[]), public.push_due() to service_role;
exception when undefined_object then
  raise notice 'No service_role here (a local test database).';
end
$grants$;

-- ============================================================ FOR THE SITE
-- The public half of the signing key, which browsers need to subscribe. Null until push-send has run once.
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = public as $$
  select public_key from public.push_keys where id = 1;
$$;
grant execute on function public.push_public_key() to anon, authenticated;

-- A visitor's device turns notifications on, or updates which bookings it holds. p_free: true asks to
-- be told when the barber is free today, false cancels that, null leaves it as it was.
create or replace function public.push_subscribe(
  p_endpoint text, p_p256dh text, p_auth text, p_device text, p_bookings text[], p_free boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_tokens text[];
begin
  if p_device is not null and not public.valid_token(p_device) then
    raise exception 'Please reload the page and try again.';
  end if;
  select coalesce(array_agg(distinct t), '{}') into v_tokens
  from (select t from unnest(coalesce(p_bookings, '{}')) t where public.valid_token(t) limit 10) x;
  insert into public.push_subscriptions as s (endpoint, p256dh, auth, device_token, booking_tokens, free_on)
  values (p_endpoint, p_p256dh, p_auth, p_device, v_tokens, case when p_free then public.shop_today() end)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    device_token = coalesce(excluded.device_token, s.device_token),
    booking_tokens = excluded.booking_tokens,
    free_on = case when p_free is null then s.free_on when p_free then public.shop_today() else null end,
    updated_at = now();
exception when check_violation then
  raise exception 'This browser''s notifications can''t be used here. Try Chrome, Firefox, Edge or Safari.';
end;
$$;
grant execute on function public.push_subscribe(text, text, text, text, text[], boolean) to anon, authenticated;

create or replace function public.push_unsubscribe(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and owner_id is null;
  update public.push_subscriptions set device_token = null, booking_tokens = '{}', free_on = null, updated_at = now()
  where endpoint = p_endpoint;
$$;
grant execute on function public.push_unsubscribe(text) to anon, authenticated;

-- Whether a device is still subscribed, and whether it's waiting to hear the barber is free.
create or replace function public.push_status(p_endpoint text)
returns table (subscribed boolean, free_today boolean)
language sql stable security definer set search_path = public as $$
  select count(*) > 0, coalesce(bool_or(free_on = public.shop_today()), false)
  from public.push_subscriptions where endpoint = p_endpoint;
$$;
grant execute on function public.push_status(text) to anon, authenticated;

-- "Send a test notification", at most once a minute per device.
create or replace function public.push_test(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.push_subscriptions where endpoint = p_endpoint) then
    raise exception 'Notifications aren''t on for this device yet.';
  end if;
  perform public.push_queue('endpoint', p_endpoint, 'Notifications are on',
    'This is how ' || (select btrim(shop_name) from public.site_config where id = 1) || ' will let you know when it''s your turn.',
    './', 'test', false, 'test:' || md5(p_endpoint) || ':' || to_char(now(), 'YYYYMMDDHH24MI'));
end;
$$;
grant execute on function public.push_test(text) to anon, authenticated;

-- The owner's devices: new bookings, messages, check-ins, cancellations, payment requests, reviews.
create or replace function public.admin_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  insert into public.push_subscriptions as s (endpoint, p256dh, auth, owner_id)
  values (p_endpoint, p_p256dh, p_auth, auth.uid())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, owner_id = auth.uid(), updated_at = now();
exception when check_violation then
  raise exception 'This browser''s notifications can''t be used here. Try Chrome, Firefox, Edge or Safari.';
end;
$$;
grant execute on function public.admin_push_subscribe(text, text, text) to authenticated;

create or replace function public.admin_push_unsubscribe(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.push_subscriptions
  where endpoint = p_endpoint and device_token is null and booking_tokens = '{}' and free_on is null;
  update public.push_subscriptions set owner_id = null, updated_at = now() where endpoint = p_endpoint;
end;
$$;
grant execute on function public.admin_push_unsubscribe(text) to authenticated;

create or replace function public.admin_push_status(p_endpoint text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_owner() and exists (select 1 from public.push_subscriptions where endpoint = p_endpoint and owner_id = auth.uid());
$$;
grant execute on function public.admin_push_status(text) to authenticated;

-- ------------------------------------------------------------ schedule
-- pg_net lets the database call push-send the moment something happens; pg_cron runs it every minute.
do $net$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available (%); notifications go out with the every-minute run.', sqlerrm;
end
$net$;

-- For each project, point push_settings at its own push-send function (the anon key is public):
--   update public.push_settings set function_url = 'https://<project-ref>.supabase.co/functions/v1/push-send',
--     anon_key = '<the project''s anon key>' where id = 1;

do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'alphicuts-push';
  perform cron.schedule('alphicuts-push', '* * * * *', $job$
    select public.push_due();
    select public.push_kick()
    where exists (select 1 from public.push_outbox where sent_at is null) or not exists (select 1 from public.push_keys);
  $job$);
exception when others then
  raise notice 'pg_cron is not available (%); notifications only go out when something happens.', sqlerrm;
end
$cron$;
