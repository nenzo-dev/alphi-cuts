-- Version 2.2.0
--   * A client whose cut starts early (say at 5pm for a 7pm booking) no longer holds the 7pm slot:
--     a started or finished cut counts in the slot it actually happened in, so the booked slot
--     opens up for someone else.
--   * Cancelled bookings are deleted straight away (unless online payment was approved or paid),
--     missed ones the day after, and all bookings and chat messages after keep_days (set by the
--     owner, 90 by default). Runs every 10 minutes with pg_cron, and whenever the owner panel opens.
--
-- Run once in the Supabase SQL editor after migration 09. schema.sql already includes all of this.

begin;

-- ============================================================ SETTINGS
alter table public.site_config add column if not exists keep_days int not null default 90;
alter table public.site_config drop constraint if exists site_config_keep_days_check;
alter table public.site_config add constraint site_config_keep_days_check check (keep_days between 7 and 365);

-- ============================================================ WHERE A BOOKING SITS IN THE DAY
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
-- cancelled and missed bookings hold nothing.
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

-- Only waiting bookings can clash on the exact same start time now.
drop index if exists public.bookings_slot_taken;
create unique index bookings_slot_taken
  on public.bookings (booking_date, slot_time)
  where status in ('booked', 'on_deck', 'called', 'checked_in');

-- The public grid shows started and finished cuts where they actually happened.
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

-- ============================================================ CANCELLING DELETES THE BOOKING
-- Kept (as cancelled) only when online payment was approved or paid, so the money is traceable.
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

-- ============================================================ STARTING A CUT (possibly early)
-- The next two people are whoever is still waiting in slots that haven't ended yet, so starting
-- someone early alerts the right people.
create or replace function public.admin_start_cut(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_date date;
  v_len int;
  v_now int := public.minute_of(public.shop_now()::time);
  v_next_id uuid;
  v_next2_id uuid;
begin
  if not public.is_owner() then raise exception 'Owner access required.'; end if;
  select slot_minutes into v_len from public.site_config where id = 1;
  update public.bookings set status = 'in_chair', started_at = now()
  where id = p_booking_id and status in ('booked', 'on_deck', 'called', 'checked_in')
  returning booking_date into v_date;
  if not found then
    raise exception 'That booking can''t be started. Refresh the list and try again.';
  end if;

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
end;
$$;

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

-- ============================================================ OWNER SETTINGS (adds keep_days)
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

-- Clear out what's already there.
select public.cleanup_old_records();

commit;

select 'migration 10 applied' as result;
