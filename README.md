# AlPhi Cuts

Booking website for Alfred Phiri's barbershop, opposite Silverest Primary School on Great East Road,
Chongwe. Live at <https://alphi-cuts.pages.dev>.

Plain HTML, CSS and JavaScript modules (no build step), a [Supabase](https://supabase.com) database,
hosted on Cloudflare Pages.

## Features

- **Live queue.** Today's slots as a grid (free, booked, in the chair) and how many people are ahead.
- **Online booking.** 30-minute slots from 9am by default. No account needed: each booking gets a
  private token kept on the client's device.
- **Alerts.** The client's page gives a heads-up a few minutes before their slot and rings when the
  slot starts (or when the barber calls them early), with an on-screen alert and a notification.
  "Add to calendar" gives a phone calendar reminder that works even when the browser is closed.
- **Owner panel** (`admin.html`): run the queue, add walk-ins, reply to messages, approve online
  payments, moderate reviews, and change hours, slot length, booking window, reminder time,
  closed days, every piece of wording on the public page, which sections show, and the legal pages.
- Reviews, chat, a style gallery with photo requests, manual mobile-money payments with receipts,
  privacy policy, terms of use and disclaimer.
- **Android app** (`android/`): shows the website and sets real phone alarms for each booking, so it
  rings at the slot time even when the app is closed. iPhones use Add to Home Screen instead, and
  must keep the site open for alerts.

## Android app

The app is plain Java with no libraries. `.github/workflows/android.yml` builds it on every push
that changes `android/`, runs `android/ci/emulator-test.sh` on an Android emulator (the alarm must
ring with the app closed and the screen off), and publishes it to `app/alphi-cuts.apk` on the
website. Screenshots from the latest test are on the `android-ci` release on GitHub.

Publishing needs the repository secret `ANDROID_SIGNING`: line 1 the keystore password, line 2
the PKCS12 keystore in base64. The keystore is kept outside this repository. Every version must be
signed with the same key or phones won't install the update; the workflow refuses to publish an
APK whose certificate doesn't match `RELEASE_CERT_SHA256`. To release a new version, raise
`versionCode` and `versionName` in `android/app/build.gradle`.

## Security

- All access control is in the database: row-level security plus `SECURITY DEFINER` functions that
  validate every input (`supabase/schema.sql`). The anon key in `js/config.js` is public by design.
- Owner passwords are handled by Supabase Auth, which stores only a hash. The panel never stores the
  password; the session token stays in the browser tab unless "Keep me signed in" is ticked.
- Visitors only ever see messages written for them. Any unexpected error shows "Sorry, we ran into
  an error. It's not you, it's us." (`js/lib/ui.js`).
- Strict security headers and Content-Security-Policy in `_headers`. The one third-party script
  (supabase-js, owner panel only) is pinned to a version and checked with Subresource Integrity.

## Setting up a new copy

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
2. Put the project URL and anon key in `js/config.js`, and set `siteUrl` to where the site will live.
3. Open `/admin.html` and use "Set up the owner account". The first account created becomes the owner.
4. Deploy: in Cloudflare, Workers & Pages → Create → Pages → Connect to Git, pick this repository,
   framework preset **None**, build command empty, output directory `/`. Every push to `master`
   redeploys.

An existing project is upgraded by running the new files in `supabase/migrations/` in order.

## Running it locally

```bash
python tools/serve.py
```

Serves the site on <http://localhost:8130> with the same headers and 404 page as Cloudflare.

## Versions

Releases are tagged in git (`v2.0.0`, ...) and listed in [CHANGELOG.md](CHANGELOG.md). The version
shown in the site footer comes from `js/config.js`; the service worker cache name in `sw.js` uses the
same number, so bump both together.

## Project layout

```
index.html, js/app.js        public site
admin.html, js/admin.js      owner panel
privacy.html, terms.html, disclaimer.html, developers.html, 404.html, js/page.js
js/lib/                      shared modules: api (database calls), ui (errors, toasts), slots
                             (time maths), content (editable wording), alarm/ringtone/notify
                             (alerts), client (device tokens), ics, image, markdown
js/legal-content.js          default legal wording
css/style.css                all styles
supabase/schema.sql          the whole database
supabase/migrations/         upgrades for an existing database
sw.js, manifest.webmanifest  installable app
_headers                     security and cache headers for Cloudflare Pages
```

## Developed by

Tadiwananshe Nenzou (BIT24230509), Kombe Simon Nanyangwe (BIT24251003), Simata Sazambile
(BIT24251377), Makanaka Joyleen Matsika (BIT24227997) and Tehillah Sakeni (BIT24127779).
