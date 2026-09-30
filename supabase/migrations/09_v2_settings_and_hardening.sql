-- Version 2.0.0
--   * 30-minute slots from 9am (the owner can change both from the panel now)
--   * new owner settings: booking window, reminder time, closed weekdays, announcement bar,
--     editable page text / legal pages (site_config.content)
--   * bookings can no longer overlap, even after the slot length changes
--   * input limits and basic spam limits on everything the public can call
--   * published reviews are readable again (the public page had no permission to read them)
--
-- Run once in the Supabase SQL editor on a project that already has schema.sql and migrations
-- 02-08 applied. A brand-new project only needs schema.sql, which already includes all of this.

begin;

-- ============================================================ SETTINGS
alter table public.site_config
  add column if not exists booking_days_ahead int not null default 7,
  add column if not exists reminder_minutes int not null default 10,
  add column if not exists closed_weekdays int[] not null default '{}',
  add column if not exists announcement text not null default '',
  add column if not exists content jsonb not null default '{}'::jsonb;

alter table public.site_config alter column open_time set default '09:00';
alter table public.site_config alter column slot_minutes set default 30;

update public.site_config set slot_minutes = 30, open_time = '09:00' where id = 1;

alter table public.site_config drop constraint if exists site_config_slot_minutes_check;
alter table public.site_config drop constraint if exists site_config_settings_check;
alter table public.site_config add constraint site_config_settings_check check (
  slot_minutes between 5 and 180
  and booking_days_ahead between 1 and 60
  and reminder_minutes between 0 and 120
  and close_time > open_time
  and closed_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]
  and jsonb_typeof(content) = 'object'
);

-- ============================================================ HELPERS
create or replace function public.shop_now()
returns timestamp language sql stable as $$
  select now() at time zone 'Africa/Lusaka';
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

-- ============================================================ BOOKINGS
alter table public.bookings add column if not exists device_token text;
create index if not exists bookings_device_token on public.bookings (device_token);

-- Which slots are taken on a given day (no names or phone numbers).
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

drop function if exists public.book_slot(date, time, text, text, text);
create or replace function public.book_slot(
  p_date date, p_slot time, p_name text, p_phone text, p_style text default null, p_device text default null
) returns text
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

-- Several bookings at once (one device can hold a few booking tokens).
create or replace function public.get_my_bookings(p_tokens text[])
returns setof public.bookings
language sql stable security definer set search_path = public as $$
  select * from public.bookings
  where client_token = any(p_tokens[1:10])
  order by booking_date, slot_time;
$$;
grant execute on function public.get_my_bookings(text[]) to anon, authenticated;

-- The page offers "Cancel" while a client is booked, on deck or called; this used to refuse the
-- last two.
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

-- ============================================================ REVIEWS
-- anon never had SELECT on the feedback table, so published reviews could not load on the public
-- page. This returns only published reviews, without ids.
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

-- The name is optional on the form, but the column is NOT NULL: an empty name used to fail.
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

create or replace function public.admin_delete_feedback(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  delete from public.feedback where id = p_id;
end;
$$;
grant execute on function public.admin_delete_feedback(uuid) to authenticated;

-- ============================================================ CHAT
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

drop function if exists public.admin_list_chat_threads();
create function public.admin_list_chat_threads()
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

-- ============================================================ STYLE REQUESTS
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

-- ============================================================ STORAGE
-- Images only, 5 MB max. Client uploads must sit in a folder named after their own token.
update storage.buckets
  set file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
  where id in ('haircut-styles', 'style-requests');

drop policy if exists style_requests_bucket_write on storage.objects;
create policy style_requests_bucket_write on storage.objects for insert
  with check (bucket_id = 'style-requests' and public.valid_token(split_part(name, '/', 1)));

drop policy if exists style_requests_bucket_delete on storage.objects;
create policy style_requests_bucket_delete on storage.objects for delete
  using (bucket_id = 'style-requests' and public.is_owner());

-- ============================================================ OWNER ACTIONS
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

-- One chair: starting a cut finishes whoever was still marked as in the chair, then alerts the
-- next two people.
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

create or replace function public.admin_finish_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'done', finished_at = now()
  where id = p_booking_id and status = 'in_chair';
  if not found then raise exception 'That cut isn''t in progress. Refresh the list and try again.'; end if;
end;
$$;

create or replace function public.admin_mark_no_show(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  update public.bookings set status = 'no_show'
  where id = p_booking_id and status in ('booked', 'on_deck', 'called');
  if not found then raise exception 'That booking can''t be marked as a no-show. Refresh the list and try again.'; end if;
end;
$$;

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

-- A walk-in gets the earliest free slot that hasn't finished yet (it used to go after the last
-- booking of the day, even when the chair was free right now).
drop function if exists public.admin_add_walkin(text, text);
create function public.admin_add_walkin(p_name text, p_phone text)
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

commit;

select 'migration 09 applied' as result;
