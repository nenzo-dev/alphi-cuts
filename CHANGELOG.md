# Changelog

## 2.3.0 (2026-09-30)

Needs `supabase/migrations/11_style_request_cleanup.sql` run on the existing database.

- Old style requests are deleted automatically after the owner's keep-days setting: ones without
  a photo by the database every 10 minutes, ones with a photo by the owner panel when it opens
  (the photo is removed first, through the storage service, so no file is left behind).
- The privacy policy and the owner setting's label mention style requests.

## 2.2.0 (2026-09-30)

Needs `supabase/migrations/10_early_cuts_and_cleanup.sql` run on the existing database.

### Changed
- A client whose cut starts early no longer holds their booked slot: a started or finished cut
  counts in the slot it actually happened in, so the booked slot opens up for someone else, and
  the next people waiting are the ones called.
- Cancelling a booking deletes it (kept only if online payment was approved or paid). Missed
  bookings are deleted the day after, and all bookings and chat messages after a number of days
  the owner sets (90 by default). This runs every 10 minutes and whenever the owner panel opens.
- Owner panel tables show as readable cards on a phone, and show when a cut actually started.
- Android app 1.1.0: stops the alarm for a booking that was cancelled elsewhere.
- The privacy policy states exactly how long records are kept.

## 2.1.0 (2026-09-30)

### Added
- Android app (`android/`). It shows the website and adds real phone alarms: a heads-up before
  the slot and a full-screen ringing alert when it starts, even when the app is closed or the
  phone has restarted. On the day of a booking it also alerts when the barber calls you early
  and when the shop replies in the chat.
- "Get the app" downloads the Android app on Android phones. iPhones keep Add to Home Screen,
  with a note to keep the site open for alerts.
- The app offers updates when a newer version is published.
- Privacy policy, terms and disclaimer cover the Android app.
- GitHub Actions builds the app, tests on an Android emulator that it rings with the app closed,
  checks it is signed with the shop's key, and only then publishes it to `/app/alphi-cuts.apk`.

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
