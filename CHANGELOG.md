# Changelog

## 2.6.0 (2026-10-07)

- A new look. Cards, the header, menus and pop-ups are see-through glass, so the page behind shows
  through.
- A ring of haircut photos turns slowly in 3D behind every page: the cuts uploaded in the owner panel
  first, then the built-in styles. It leans towards the mouse, is bright at the top of the home page
  and dims as you scroll down so the text stays easy to read.
- Buttons glow, with a sweep of light when you point at them. Cards light up under the mouse, style
  photos lean towards it in 3D, a soft light follows the mouse, and on a phone a glow shows where you
  tap. Sections light up as they scroll into view.
- Open pages update themselves. When a new version of the site is published, an open page reloads at
  a quiet moment and comes back to the same place, so nobody has to refresh or press Update. It waits
  while someone has a message typed but not sent, a pop-up is open or an alarm is ringing. The Android
  app shows this site, so it gets the new look and the updates the same way, without a new app download.
- Phones with very little memory get a lighter version without the blur, and the movement stays off
  for anyone whose phone is set to reduce motion.

## 2.5.1 (2026-10-02)

- The update notice in the Android app goes away once Update is pressed. On app 1.0.0 and 1.1.0 the
  gold bar stayed after the download started, and the pop-up came back when the app was opened
  again. Now neither comes back for that version for an hour, which leaves time to install it. If the
  download fails, Update shows again straight away.

## 2.5.0 (2026-10-02)

Needs `supabase/migrations/12_arrival_checkin.sql` run on the existing database, then the shop's
location set once in the owner panel (Arrivals).

- Checking in on arrival. A client who turns on "Check me in when I arrive" is checked in when their
  phone reaches the shop, on the day of the booking from two hours before the slot until it ends. The
  owner panel shows them as checked in, tagged "arrived". In the Android app (1.3.0) this works with
  the app closed if location is allowed all the time; in a browser it works while the page is open.
  The position is checked again by the database and never stored.
- "You're next": a checked-in client is told when they're next, and asked not to leave the shop.
- Into the chair automatically: every minute the database puts the next checked-in client whose slot
  has started in the chair, when the chair is free (or the cut in it has been left running for more
  than two slots). The owner can turn either automatic step off.
- Owner panel: new Arrivals page to set the shop's location ("Use my current location"), how close
  counts as arrived, and the two automatic steps.
- "Open in Maps" goes to the shop's exact location once it's set.
- The site now allows location for its own pages (Permissions-Policy), which it blocked before.
- Privacy policy, terms and disclaimer explain checking in on arrival.

## 2.4.0 (2026-10-02)

- Android app 1.2.0 updates itself. It looks for a newer version when it opens and every few hours
  in the background, and shows a notification and a pop-up saying the version on the phone will no
  longer be supported. "Update now" closes the pop-up, downloads the new version, checks it's the
  exact file published here and hands it to Android's installer; the bar at the top shows progress.
- If the phone blocks the install, the app says why, and "Open settings" goes straight to the setting
  that lifts the block: "Install unknown apps" for the app, a phone-wide block on apps from outside
  the Play Store (such as Samsung's Auto Blocker), a security check such as Google Play Protect, or
  low storage. Once "Install unknown apps" or the phone-wide block is turned off, the update carries
  on by itself.
- Phones with app 1.0.0 or 1.1.0 get the same pop-up and download the new version through the browser.
- The privacy policy and terms mention the update checks.

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
