-- Fixes a real production bug found while testing: book_slot() failed for every client with
-- "unrecognized encoding: base64url" because this Supabase project's Postgres version doesn't
-- support the 'base64url' encode() format. Switching to 'hex' (universally supported, same entropy
-- for the same byte length) fixes new bookings immediately. No data migration needed -- the column
-- default is only used at insert time, and every prior attempt to insert with the broken default
-- would have errored and rolled back, so there are no existing rows to fix.

alter table public.bookings
  alter column client_token set default encode(gen_random_bytes(18), 'hex');

select 'migration 04 applied' as result;
