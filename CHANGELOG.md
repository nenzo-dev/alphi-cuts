# Changelog

## 2.10.2 (2026-10-10)

The Android app goes to 1.4.0 (built, tested and published by GitHub Actions). No database change.

- In the app, Sounds now chooses each alert's sound right in the app: for Your turn, Booking
  updates and Messages, pick the phone's usual sound, one of the website's six tones (now built
  into the app, made by tools/make_tones.py from the same notes), any of the phone's own sounds
  (Android's sound list opens in the app), or a sound file of your own (Android 10 and later; it's
  copied into the phone's sounds under "AlPhi Cuts" so Android can play it). Each has a Play
  button, and the choice takes effect straight away.
- The emulator test checks it: the alarm and the heads-up move to channels with the chosen tones,
  the alarm rings on the new channel, and the phone's sound list opens in the app. The test no
  longer waits for the app's first frame, and a slow screenshot is only noted.

## 2.10.1 (2026-10-07)

- Photos and icons stay saved on the phone across releases, so a new version no longer downloads
  them all again.
- The Android app's emulator test puts a time limit on every command it sends the emulator and
  logs each one (ci-results/adb-log.txt), so a hung emulator fails the run within minutes and names
  the command, instead of the job being cancelled after 35 minutes (which kept app 1.4.0 from
  being published).

## 2.10.0 (2026-10-07)

Faster, especially on slow connections and older phones. No database change.

- Pages open from the copy kept on the phone instead of waiting for the network for every file.
  A new release downloads in the background and open pages switch to it by themselves, as before.
  Every page (the owner panel too) now sets this up, not only the home page.
- The home page shows straight away with the shop's settings from the last visit and swaps in the
  latest ones as soon as they arrive.
- The list of uploaded cuts is asked for once per page instead of twice, and the 3D ring shows the
  uploaded cuts from the last visit straight away instead of being drawn twice.
- Lighter effects: the ring rests while the page scrolls and once you're past the top, the soft
  lights behind it no longer use a moving blur, and the gold buttons pulse a few times and then
  glow steadily. On phones the panels stay see-through without the frosted blur, which phones had
  to redraw whenever anything behind them moved. The hover light only runs with a mouse.
- The owner panel loads its scripts all at once.

## 2.9.0 (2026-10-07)

No database change. The Android app goes to 1.4.0 (built and published by GitHub Actions).

- Sounds: everyone can choose their own tones. In a browser there are six sounds (phone ring,
  two-note chime, bell, alarm clock, marimba, soft rise) for "it's your turn" and for heads-ups and
  messages, each with a Play button, or a sound file of their own (MP3, M4A or WAV up to 3 MB, kept
  on the device and never uploaded).
- Sounds is in the bell's panel and under "My booking" ("Choose your sounds"), and in the owner
  panel for the new-booking sound.
- With the site closed, notifications use the phone's own sound, which websites can't change; the
  panel says where to change it on Android, iPhone and computers.
- In the Android app, Sounds has "Choose sound" for Your turn, Booking updates and Messages, which
  opens the phone's own sound picker for that alert (app 1.4.0).
- The privacy policy says the chosen sounds and sound file stay on the device.

## 2.8.1 (2026-10-07)

- Fixed: the owner panel couldn't sign in since 2.7.0. An apostrophe in one of its messages stopped
  the panel's script from loading, so the sign-in button did nothing.
- A check on GitHub now makes sure every script on the site parses, on each push.

## 2.8.0 (2026-10-07)

Needs `supabase/migrations/14_one_booking_and_payment_expiry.sql` run on the existing database.

- One booking at a time per person. A second booking is refused while the same phone number, or the
  same device, already has one waiting or in the chair. Cancelling it, or the cut being done, frees
  them to book again. On a device that already has a booking, the form says so and points to
  "My booking" instead of showing the booking fields.
- A request to pay online that isn't approved by the time the slot starts is cleared. The client
  gets a notification (if they turned them on), a message on the page if it's open, and a note on
  their booking. Online payment can't be asked for once the slot has started. While a request
  waits, the booking says when it will be cleared.
- Find us: Call and WhatsApp buttons with icons, and a map picture with a glowing marker where the
  shop is. The picture and the "Open" button below it open Google Maps at the shop.
- In the owner panel (Public page): the map link, the button and marker wording, the new booking
  and payment messages, and an option to hide the map picture.
- The terms explain the one-booking rule and when payment requests are cleared; the privacy policy
  lists the new notification.

## 2.7.0 (2026-10-07)

Needs `supabase/migrations/13_push_notifications.sql` run on the existing database, and the
`push-send` Edge Function deployed (supabase/functions/push-send/index.ts, Edge Functions > Deploy a
new function > Via editor). The function makes its own signing keys the first time it runs.

- Notifications that arrive even when the site is closed, on Android phones and computers (Chrome,
  Edge, Firefox) and on iPhone once the site is added to the Home Screen. Clients hear about the
  heads-up before their slot, being 2 away, being called next, their turn starting, being next once
  checked in, replies from the barber, a cancellation by the shop, an approved online payment and,
  if they ask, when the barber is free that day.
- A bell at the top of every phone and computer screen, with a glowing dot while notifications are
  off. It opens a panel that says what you get, with one button to turn them on, a test button, a
  "free today" option and a way to turn them off. iPhone users get step-by-step Home Screen
  instructions, and anyone who blocked notifications is shown how to allow them again.
- A prompt at the bottom of the home page (once a week until it's dismissed) and straight after
  booking. "My booking" has a gold "Turn on notifications" button.
- "Tell me when the barber is free" now works with the site closed.
- The owner panel has "Notifications on this phone" at the top of Today's queue: new bookings,
  messages, check-ins, cancellations, online payment requests, style requests and reviews.
- The notification wording is editable in the owner panel (Public page, Notifications), and the
  heads-up, turn and "next" messages use the same wording as the alarms.
- The privacy policy explains notifications; the disclaimer no longer says browser alerts only work
  while the site is open.

## 2.6.2 (2026-10-07)

- A page left open in the background now updates itself there too, so it is already on the newest
  version when someone comes back to it, instead of reloading as they return.

## 2.6.1 (2026-10-07)

- "Free right now" is now a glass panel with a pulsing green dot, a slow sweep of light and a glowing
  gold Book button, instead of a flat gold box.
- The same glass look for the other flat blocks: the announcement and app-update bars, chat bubbles,
  success and error messages, payment notes, the style chip, status labels, the "arrived" tag, the
  alarm card, the close button on pop-ups and the photo delete buttons.
- Soft glowing lines between the sections of the home page instead of flat rules, and table rows in
  the owner panel light up under the mouse.

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
