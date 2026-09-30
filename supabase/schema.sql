-- AlPhi Cuts database schema (v2.0.0).
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
  updated_at timestamptz not null default now(),
  constraint site_config_settings_check check (
    slot_minutes between 5 and 180
    and booking_days_ahead between 1 and 60
    and reminder_minutes between 0 and 120
    and close_time > open_time
    and closed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]
    and jsonb_typeof(content) = 'object'
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
  payment_status text not null default 'none' check (payment_status in ('none', 'requested', 'approved', 'paid')),
  payment_requested_at timestamptz,
  payment_approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index bookings_slot_taken
  on public.bookings (booking_date, slot_time)
  where status not in ('cancelled', 'no_show');
create index bookings_device_token on public.bookings (device_token);

alter table public.bookings enable row level security;
create policy bookings_owner_all on public.bookings for all
  using (public.is_owner()) with check (public.is_owner());

-- True when an active booking on that day overlaps [p_slot, p_slot + p_minutes). Comparing start
-- times this way also catches older bookings made when the slots were a different length.
create or replace function public.slot_is_taken(p_date date, p_slot time, p_minutes int)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.bookings
    where booking_date = p_date
      and status not in ('cancelled', 'no_show')
      and abs(public.minute_of(slot_time) - public.minute_of(p_slot)) < p_minutes
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
  select b.slot_time, b.status
  from public.bookings b
  where b.booking_date = p_date
    and p_date between public.shop_today() - 1 and public.shop_today() + 60
    and b.status not in ('cancelled', 'no_show')
  order by b.slot_time;
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

  -- Bookings for the same day go through one at a time, so two people can't take overlapping slots.
  perform pg_advisory_xact_lock(hashtext('book_slot:' || p_date::text));

  if (select count(*) from public.bookings
      where booking_date = p_date
        and status in ('booked', 'on_deck', 'called', 'checked_in')
        and right(regexp_replace(client_phone, '\D', '', 'g'), 9) = right(v_digits, 9)) >= 2 then
    raise exception 'This phone number already has 2 bookings that day.';
  end if;
  if public.slot_is_taken(p_date, p_slot, c.slot_minutes) then
    raise exception 'That time was just taken. Please pick another.';
  end if;

  insert into public.bookings (booking_date, slot_time, client_name, client_phone, style_choice, device_token)
  values (p_date, p_slot, v_name, v_phone, nullif(btrim(coalesce(p_style, '')), ''),
          case when public.valid_token(p_device) then p_device end)
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
    closed_weekdays = c.closed_weekdays, content = c.content,
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

-- One chair: starting a cut finishes whoever was still marked as in the chair, then alerts the
-- next two people (the next one is "called", the one after is "on deck").
create or replace function public.admin_start_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_date date; v_slot time; v_next_id uuid; v_next2_id uuid;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'in_chair', started_at = now()
  where id = p_booking_id and status in ('booked', 'on_deck', 'called', 'checked_in')
  returning booking_date, slot_time into v_date, v_slot;
  if not found then
    raise exception 'That booking can''t be started. Refresh the list and try again.';
  end if;

  update public.bookings set status = 'done', finished_at = now()
  where booking_date = v_date and status = 'in_chair' and id <> p_booking_id;

  select id into v_next_id from public.bookings
    where booking_date = v_date and slot_time > v_slot and status in ('booked', 'on_deck', 'called')
    order by slot_time limit 1;
  if v_next_id is not null then
    update public.bookings set status = 'called', called_at = now() where id = v_next_id;
    select id into v_next2_id from public.bookings
      where booking_date = v_date and slot_time > v_slot and status in ('booked', 'on_deck', 'called') and id <> v_next_id
      order by slot_time limit 1;
    if v_next2_id is not null then
      update public.bookings set status = 'on_deck', on_deck_at = now() where id = v_next2_id;
    end if;
  end if;
end;
$$;
grant execute on function public.admin_start_cut(uuid) to authenticated;

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
  update public.bookings set payment_status = 'requested', payment_requested_at = now()
  where client_token = p_token and payment_status = 'none';
  if not found then
    raise exception 'Online payment can''t be requested for this booking right now.';
  end if;
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
