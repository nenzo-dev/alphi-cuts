# Changelog

## 2.15.2 (2026-10-29)

No database change.

- The payment screenshot check was turning down real payments (wrong editing-app guess, an old file date, the name or transaction ID not quite matching, more than one check disagreeing). Now only two things turn a screenshot down: it isn't a picture, or it doesn't show the full amount. Everything else the reader finds is kept as a note for Mr Alfred to see, not a reason to reject it, since he looks at every accepted screenshot and confirms the money himself.
- The note under the screenshot field no longer claims a 30-minute cutoff that isn't checked any more. It now says to make sure the screenshot clearly shows the amount, and to show it to Mr Alfred when you arrive.

## 2.15.1 (2026-10-11)

No database change.

- On a phone, each line of the payment details now has its label ("Airtel agent code") on one line with the answer under it, instead of the label breaking onto two lines beside the number. On wider screens the label stays beside the answer.
- The amount (K50) is a normal-sized gold pill instead of a big one.

## 2.15.0 (2026-10-11)

No database change.

- **Nicer fields.** The boxes you type in are taller and rounder, lit from inside, with a gold glow when you are in
  them. Name, phone and sign-your-name boxes carry a small icon, the Day and Time lists have a proper arrow, and
  every "Choose File" on the site is a gold button in a dashed box.
- **The payment details are a card.** The amount is a big gold pill, and each line of the owner's payment details
  is a row: what it is on the left, the answer on the right, and a number (the agent code or phone number) is large,
  gold, and has a Copy button. The owner still writes the details as plain lines in the owner panel
  ("Airtel agent code: 20194278"); lines that are not "name: value" show as plain notes.
- **The screenshot box.** Instead of the browser's grey file button there is a large box with a gold arrow:
  "Choose your screenshot". After choosing, the box turns green, shows a small picture of what was chosen and the
  file name, and says "Tap to choose a different one".
- **A guide through booking, for people who are slow or new to phones** (js/lib/guide.js, after the money changing
  app's finger and hints). A row of steps (Pay, Upload, Sign, Book; or Time, Details, Book when no payment is needed)
  fills as each one is done, one line says what to do next, with arrows running towards it, the box to use glows,
  and after 3.5 quiet seconds a finger taps it. It follows the person: Copy the number, choose the screenshot (the
  line says to wait while it is read), sign, pick a time, type a name and a phone number, tap Book. It scrolls the
  next box into view when a step is done and it is off the screen. After someone has done a step twice the finger no
  longer shows for it (the words and the glow stay). A turned-down screenshot shows no hint, only the box that says
  what to do. If a browser will not copy, tapping Copy still moves on, and says to press and hold the number.
- The words for the steps and the hints, and for the screenshot box, can be changed in the owner panel (Public page
  tab, "Booking steps and hints").

## 2.14.1 (2026-10-11)

No database change.

- The shop name and the line under it at the top of the home page are easier to read over the brighter photos: a darker edge behind the letters and a slightly stronger pool of shade behind the text, with the photos themselves left bright.

## 2.14.0 (2026-10-11)

No database change.

- **A brighter look, in the colours of the money changing app.** A deep navy page lit by gold, blue and violet
  light, bright glass panels with a warm light in the corner and a clear edge, gold buttons with a glow, white
  headings and lighter small text. The input boxes and the payment details box are light glass instead of
  near-black. Nothing is dimmed any more: free times that have passed are struck through instead of faded, locked
  fields are only slightly softened, the ring of haircut photos is brighter and softens only a little as you
  scroll (it used to fade to a quarter), and the backdrop behind pop-ups is lighter.
- **Motion, in the style of the money changing app** (js/lib/motion.js). The top of the home page rises in one
  piece after another. Headings, cards and style photos rise into place when you scroll to them, once. The day's
  times pop in one after another, and when the queue is refreshed only the times that changed are touched: one
  opening glows green, one being taken glows red. "Ahead in the queue" counts up and glows when it changes. In the
  owner panel each tab rises in when it opens and the day's numbers count up and glow. A new chat message slides
  in, pop-ups pop in, the link of the section you are reading lights up in the top bar, the gold buttons and the
  price pill shine now and then, and the logo floats a little.
- **Light mode.** A phone with little memory or few cores starts without blur and without anything that moves on
  its own, and any phone that cannot hold about 30 frames a second switches to it and remembers (`ac_lite`).
  People who ask their phone for less motion get none. Entrances never replay when a block is redrawn.
- The browser bar and the installed app's splash screen are navy too. The Android app's own loading background,
  alarm screen and offline page still use the old dark brown until the next app release.

## 2.13.0 (2026-10-11)

Run `supabase/migrations/20_strict_screenshot_checks.sql` once in the Supabase SQL editor, after 19.

- **Checked against a real client message** (Airtel's "You have withdrawn ZMW 50.00 from 20194278 ALFRED
  PHIRI. Bal is ZMW 124.25. TID: CO260928.1202.I86552."). The reader now: finds the amount when a large font
  puts "ZMW" and the number on different lines (and still skips the balance), accepts "withdrawn ... from
  ALFRED PHIRI" as the agent being paid (a name after "received from" is still the sender), counts
  "withdrawn" as a success message, and reads the big letter I in a transaction ID the same way however it
  looks in the picture (I, l, 1 or |), so the same payment always gives the same ID. The real picture was
  read and approved through the real reader (with the clock set to just after it was paid), and the same
  message is turned down when it is over an hour old or has the wrong amount or name.
- **Very strict.** Any one of these failing turns the screenshot down as "Fake proof of payment":
  - the owner's name has to be on it, **and** the account from the payment details (the agent code) when
    the payment details have one (before, either was enough);
  - the payment time (inside the transaction ID, or beside the date) and the time the file was saved must
    be from the last hour, and a missing one is turned down (clocks may differ by 5 minutes, not 10); so is
    a screenshot with no date or no time on it;
  - any date or time saved inside the picture (its EXIF details) must be from the last hour too;
  - the date written on it must be the same day as the date in the transaction ID (no day of slack), and a
    time written beside a date must be within 10 minutes of the time in the ID;
  - only one payment may show: two different transaction IDs in one picture are turned down (the Airtel app's
    Transaction Details screen shows the same ID twice, in the message and in its own row, and the two readings
    can differ by a letter, a digit or a stray character, so IDs from the same day within two minutes of each
    other, or that end alike, count as one payment);
  - it must say the payment went through ("successful", "sent", "withdrawn" ...) and must not say anything
    that sounds unfinished or refused ("enter your PIN", "please confirm", "do you want", "are you sure",
    "in progress", "awaiting", "denied", "blocked", "timed out", as well as "failed", "pending" ...);
  - the writing has to be read with at least 65% confidence (it was 45%).
  The database repeats the main ones (migration 20): file time, payment time, the owner's name and the
  account must all be there and right, and a missing value is refused. There is no check on the file's name:
  phones name screenshots differently, and the name is easy to change.
- **The Airtel app's "Transaction Details" screen works as well as the SMS** (a real client has already booked
  with one on 2.12.3). It was checked again against the strict rules with mock copies at six phone sizes
  (540 to 1080 pixels wide): all accepted, with the reading 91-94% sure; the same screen with no agent code,
  K20, or a payment 95 minutes old is turned down. Transaction IDs are now read the same way each time
  (a digit where a letter belongs is a letter read wrongly, a stray character in front or a dot inside is
  dropped), so the same payment gives the same ID from an SMS and from the app.
- **Nothing the reader found is shown to the client any more:** no "Paid to / Amount / Transaction ID"
  box after a screenshot is accepted, no "we can see your name in the screenshot" note, and the ticket no
  longer repeats the transaction ID. An accepted screenshot says so and tells the client to call Mr Alfred;
  a turned-down one says "Fake proof of payment". Mr Alfred still sees everything, with the reasons for a
  turned-down screenshot in Payments > Turned-down screenshots.
- While the screenshot is being read the page says "Please wait, this may take a while."

## 2.12.3 (2026-10-11)

No database change.

- The note under the screenshot field now says only "Upload the payment screenshot soon after payment,
  at least in less than 30 minutes." The line about each screenshot or payment being usable once is gone
  from there (the terms still say it). The real limit stays an hour and is not shown.

## 2.12.2 (2026-10-11)

Run `supabase/migrations/19_rejected_proofs_log.sql` once in the Supabase SQL editor, after 18.

- A turned-down screenshot now only says **"Fake proof of payment"** and tells the client to call the
  owner. The reasons are no longer shown to the client, because they would show how to get a fake past
  the checks. A screenshot that is accepted shows only who was paid, the amount and the transaction ID:
  the file details and the list of what was checked are gone from the client's view. The booking
  errors from the database are one plain message too, and the terms no longer list the checks.
- The reasons go to the owner instead. The page sends each turned-down screenshot, with its picture and
  the reasons, to a private log (`rejected_proofs`), and the owner panel (Payments > Turned-down
  screenshots) lists them with a View button: the picture, what was read, the file's details and why it
  was turned down. When a client calls and really paid, Mr Alfred can see why and book them in. The log
  and its pictures are deleted after 14 days; a browser can add at most 20 an hour.
- The note under the screenshot field (and the terms) no longer give the real time limit: they say to
  upload the screenshot soon after paying, at least within 30 minutes. The real limit stays an hour, so
  there is room for slow phones, and nobody learns the exact cut-off.

## 2.12.1 (2026-10-11)

Run `supabase/migrations/18_sign_name_drop_sms.sql` once in the Supabase SQL editor, after 17.

- After a payment screenshot is accepted, the client **signs with their name as it shows when money
  is received**: the name their mobile money number is registered in (for Airtel, what Mr Alfred's phone
  shows after "received from"). The owner sees it as "Paid as" in Payments, the queue and View proof,
  and matches it, the transaction ID (TID) and the amount to the message on his phone, so each person
  claims their own payment. The page also tells the client whether the name is in their screenshot (it
  often isn't, and that is fine). The database refuses a booking without a first and last name.
- The wording is clear that an accepted screenshot only lets you book a slot: it does not guarantee
  service from Mr Alfred. The payment box carries a warning with a Call button, and the accepted
  message, the booking confirmation and the ticket all tell the client to call him to confirm he has
  received the payment, and that he is not responsible for money sent to other people or numbers. The
  terms say the same.
- A screenshot, or its transaction ID, can only ever back one booking. The page now says so as soon as
  the screenshot is picked (proof_in_use), not after the form is filled in. Cancelling no longer gives
  the payment back: only a payment the owner marked "Not received" is free again.
- Nothing older than an hour: the screenshot file must have been saved in the last hour, and the payment
  on it (the time in an Airtel transaction ID, or the time beside the date) must be at most an hour old
  and not in the future (10 minutes' difference between phone clocks is allowed). The database checks it
  too.
- Checked against a real Airtel "received" message from Mr Alfred's phone: Airtel writes dates month
  first (10-11-2026 is 11 October, not 10 November), and the transaction ID carries its own date and time
  (CO261011.1254.A33706 is 11 Oct 2026 at 12:54). The reader now understands both, takes the date from
  the ID, and turns a screenshot down when the date written on it disagrees with the ID's date. "Comm"
  (commission) is no longer mistaken for the amount.
- The SMS-forwarding way of checking payments (2.12.0, part 2) is removed: Mr Alfred's phone can't
  forward messages. Its card in Payments, its page code and its tables and functions are gone
  (migration 18). The screenshot way, the owner's confirmation, and "Book a client in" stay.

## 2.12.0 (2026-10-11)

Pay first with a screenshot, and walk-ins come last. Run `supabase/migrations/16_payment_screenshots.sql`
once in the Supabase SQL editor, after 15. (Until then the site keeps working as in 2.11.0.)

- With pay-before-booking on, a client uploads a screenshot of their payment instead of typing a
  reference. The page reads it on the client's own phone (Tesseract, kept in `vendor/tesseract`, no
  picture is sent anywhere to be read) and shows what it found: who was paid, the amount, the
  transaction ID, the date and time, the network, and the file itself (name, type, size, pixels, when
  it was saved, the camera or editing app named in its metadata, a fingerprint).
- A proof is turned down when the person paid isn't the owner (by name, or by the account in the
  payment details), the amount is below the price, there is no transaction ID, the payment looks old
  or failed, the picture is edited or a camera photo, an old file, unreadable, or already used. The
  client is told why and to call Mr Alfred to confirm he has seen their payment. Only an accepted
  screenshot opens the free times.
- Even then the client is told to show the payment to the owner, who confirms it. The screenshot is
  saved in a private bucket and the owner sees it, with everything read, under View proof (Payments
  and the queue). The database checks what it can (accepted, the picture is in the bucket, the amount,
  the transaction ID, one screenshot or transaction per booking) but can't read the picture, so the
  owner's confirmation is what counts.
- Walk-ins come last: they are tagged, listed after booked clients, and never started automatically
  ahead of a booked client or when a booked client's slot is about to start.
- Bookings tab: "Book a client in" for someone whose screenshot was turned down but who has shown
  the payment. It counts as paid.
- Screenshots nothing refers to any more are deleted by the owner panel.
- Terms and privacy describe the screenshot, the checks and the order of service.

Part 2 (migration 17, after 16): payments checked against the owner's own messages.

- The owner's Android phone forwards each mobile-money "money received" message to the site (an SMS
  forwarding app; the owner panel, Payments, shows the address, headers and body to put in it and
  makes a secret, shown once, of which only a hash is kept). Messages from mobile-money and bank
  senders are read (amount, transaction ID, who sent it) and kept; all others are dropped.
- With "Check payments automatically" on, a client pays, types the transaction ID from their message
  (or uploads a screenshot and the page reads the ID), and the site looks for that payment among the
  received messages. It keeps looking for about two minutes in case the message is a little late. Once
  found (big enough, from the last 3 days, not spent on another booking) the client can pick a time, and
  the booking is made as paid in one step, with nothing for the owner to confirm. A made-up transaction
  ID can't be found, so this can't be faked from the page.
- A cancelled booking gives its payment back. The owner sees every message received and which booking
  used it, can switch the checking off (the screenshot way takes over) and can make a new secret.
- If the owner's phone is off nothing arrives and nobody can book until it is back or the owner switches
  checking off. Message formats are read forgivingly and every message is kept, so they can be read again.

## 2.11.0 (2026-10-11)

Pay first, then book. Run `supabase/migrations/15_pay_first.sql` once in the Supabase SQL editor
(the site keeps working the old way until you do).

- The payment details saved in the owner panel (Payments) are now shown to everyone on the booking
  form, with the price. Before, only clients the owner had approved one by one could see them.
- A client pays first, then enters the reference from their payment message (the transaction ID).
  Only then do the free times open. The booking holds the slot straight away and is marked "Paid,
  to confirm".
- The owner is notified and sees the booking in Payments (and in the queue) with the reference.
  "Mark paid" confirms it; "Not received" cancels it and frees the slot. The client is told either
  way.
- One reference can back one booking, and a person still holds one booking at a time.
- A booking the owner hasn't confirmed by its slot time is cleared (the client is told to message
  the owner with their reference), unless the client is already at the shop. An unconfirmed booking
  is never started automatically; the owner can still start it by hand.
- A switch in Payments ("Clients must pay before they can book") turns this on or off. It is on
  after the update, and only applies once payment details are saved. Walk-ins are not charged here.
- All the new wording can be changed in the Public page tab, under "Paying before booking".
- The terms and the disclaimer describe paying first. (If the owner saved their own wording for
  them, that wording is kept as it is.)

## 2.10.4 (2026-10-10)

The Android app goes to 1.4.1 (built, tested and published by GitHub Actions). No database change.

- Sounds in the app is clearer: each alert shows what it plays now, a list of tones, and two
  buttons, "Phone's sounds" (Android's sound list, opened in the app) and "My own file" (the
  phone's file picker, for any song or sound file). Play warns when the phone is on silent or the
  volume is off.
- A sound file of your own now works on Android 7, 8 and 9 too: the app asks for storage access
  once and saves the file among the phone's sounds. Phones without the usual file picker get any
  other app that can hand over files.
- An older app sees an "Update the app" button in Sounds instead of only being told to update.
- The emulator test now does what a person would: it opens the phone's sound list from the app,
  picks a sound and taps OK, and opens the phone's file picker from the app and picks an audio
  file, and checks that each becomes that alert's sound (and that the file is saved among the
  phone's sounds).

## 2.10.3 (2026-10-10)

- A device with no real graphics chip (an emulator, or a browser drawing everything in software)
  gets a still, flat page: no moving 3D ring, no blur, no animations. A tiny script at the top of
  each page (js/soft-graphics.js) decides before the page is drawn. Real phones and computers keep
  the full look. The Android emulator test froze two seconds after the app opened the live site;
  this keeps the site from overloading a software-drawn screen.
- The emulator test first opens a plain page in the app, to tell a stalled emulator from a page
  that is too much for it. It runs every check that matters for the app first (alarm with the app
  closed, arrival, self-update, sounds) and opens the live website last; the emulator draws in
  software and freezes on the live site, so a freeze there is noted, with the emulator's last log
  lines (logcat-last.txt), instead of discarding the whole run.

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
