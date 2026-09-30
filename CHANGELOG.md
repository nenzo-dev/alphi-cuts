# Changelog

## 2.0.1 (2026-09-30)

- Links go straight to the final page addresses (Cloudflare was redirecting every `.html` link,
  costing an extra round trip).
- The offline copy no longer stores a redirect for `index.html`.

## 2.0.0 (2026-09-30)

Needs `supabase/migrations/09_v2_settings_and_hardening.sql` run on the existing database. Until
then the site keeps working with the old settings.

### Added
- Slots are now 30 minutes from 9am by default.
- Owner panel settings for slot length, opening hours, how many days ahead people can book,
  the heads-up time before a slot, and closed weekdays.
- Every piece of wording on the public page can be changed from the owner panel, sections can be
  shown or hidden, and there is an optional announcement bar.
- Privacy policy, terms of use and disclaimer pages, editable from the owner panel.
- "Developed by" page.
- Booking alerts: heads-up before the slot, ringing and a full-screen alert when the slot starts or
  the barber calls, "I'm here" and "Stop alarm" buttons, and "Add to calendar".
- Owner can cancel bookings and delete reviews; new bookings chime in the owner panel; unread
  message and payment badges.
- "Keep me signed in" option on the owner login (off by default).
- Security headers, Content-Security-Policy and a proper 404 page.

### Fixed
- Published reviews never appeared on the public page (the public had no permission to read them).
- A review without a name failed to save.
- "Cancel booking" failed for clients who were on deck or called.
- Walk-ins were put after the last booking of the day instead of the next free slot.
- The booking form showed every time as free on days other than today.
- Two bookings could overlap after the slot length changed.
- Booking a second time on the same device hid the first booking and emptied the chat.
- Notifications never showed on Android phones.
- Alert sounds could stay silent because browsers block audio until the page is tapped.
- Starting a cut left the previous client marked as in the chair.

### Changed
- Visitors never see raw error messages; unexpected errors show one friendly line.
- The public page no longer downloads the full Supabase library, and loads its data in parallel.
- Smaller images: resized logo and icons, and gallery thumbnails.
- Photos are resized on the phone before upload.
- Server-side limits on names, phone numbers, messages, reviews and uploads, plus basic spam limits.

## 1.0.0 (2026-09-28)

First version: live queue, booking, reviews, chat, style gallery and requests, manual online
payments with receipts, owner panel.
