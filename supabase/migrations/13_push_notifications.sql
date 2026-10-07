-- 2.7.0: notifications that reach people even when the site is closed (Web Push).
--
-- A phone or computer that turns on notifications sends its push address (from its browser's push
-- service: Google, Mozilla, Apple or Microsoft) to push_subscribe(), together with the tokens of the
-- bookings made on it and its chat token. The owner's devices are linked to the owner's account
-- instead. Nothing here holds a name or phone number.
--
-- When something happens, a trigger (or push_due(), every minute) writes a notification to
-- push_outbox. The "push-send" Edge Function (supabase/functions/push-send) takes the waiting
-- notifications with push_take(), encrypts each one for the device it goes to and hands it to the
-- push service. The function makes its own signing keys the first time it runs (push_keys), so no
-- secret has to be copied anywhere by hand.
--
-- Run once in the Supabase SQL editor, after 12_arrival_checkin.sql. Then deploy the push-send
-- function (Edge Functions > Deploy a new function > Via editor, name "push-send").

-- ============================================================ TABLES (no direct access for visitors)
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

-- ============================================================ CLEANUP
-- Sent notifications are kept two days; devices not seen for the keep-days setting are forgotten,
-- and bookings that no longer exist are dropped from each device's list.
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

-- ============================================================ SCHEDULE (this project)
-- pg_net lets the database call push-send the moment something happens; pg_cron runs it every minute.
do $net$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available (%); notifications go out with the every-minute run.', sqlerrm;
end
$net$;

update public.push_settings set
  function_url = 'https://dbiojclfbqmvpvmqsfhv.supabase.co/functions/v1/push-send',
  anon_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiaW9qY2xmYnFtdnB2bXFzZmh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MDE5MDIsImV4cCI6MjEwNjE3NzkwMn0.mVHW9t3J1LUPzIqxzhccXm07JanRTwXt41rJwfLgU8A'
where id = 1;

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
