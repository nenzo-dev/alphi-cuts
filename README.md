# AlPhi Cuts — Alfred Phiri's Barbershop

A booking website for a real, single-chair barbershop: opposite Silverest Primary School, Great East
Road, Chongwe. Built the same way as MindCare — plain HTML/CSS/JavaScript modules with no build
step, backed by a free [Supabase](https://supabase.com) project, deployable to Cloudflare Pages.

## What it does

- **Live queue, visible before you leave home.** The homepage shows today's slots as a coloured grid
  (free / booked / in the chair) and a plain sentence — "3 slots ahead right now, next free slot
  10:40am" — so nobody walks over only to find a long wait.
- **Booking, 8am–8pm, 20 minutes a cut.** Pick a day (today → 6 days ahead), pick a free
  slot, give a name and phone number. No account needed — the booking is tied to a private token
  kept in that browser only.
- **The queue actually advances itself.** When Alfred taps **Start cut** in the owner panel, that
  client moves to "in chair" *and* the next booked client is marked **called** in the same instant —
  their own page starts ringing ("you're up next, be ready"). If they don't check in, Alfred can mark
  them a no-show and give the slot to someone else, exactly as asked.
- **Reviews, chat, and shop details** — all editable by Alfred himself from the owner panel, no
  code changes needed for a new phone number, price, or opening hours.
- **Installable app**, with a QR code on the site: Android gets the install prompt straight away;
  iPhone/iPad are pointed at Add to Home Screen (Apple does not allow a downloadable file there
  without a paid Developer account and a Mac — the installed web app *is* the real iPhone app,
  same as MindCare's).

## One-time setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is enough for a
   single shop).
2. **Run the schema**: open the project's SQL editor, paste in the whole contents of
   `supabase/schema.sql`, and run it once. This creates every table, security policy and function
   the site needs — nothing else to configure.
3. **Create Alfred's login**: Supabase dashboard → Authentication → Users → Add user
   (his email + a password he'll remember). Then, in the SQL editor, run:
   ```sql
   insert into public.profiles (id, full_name)
   values ('<the new user's UUID, shown in the Users list>', 'Alfred Phiri');
   ```
   That one row is what makes that login a real owner — everyone else who signs up (there is no
   public sign-up form) stays a regular visitor.
4. **Connect the site**: open `js/config.js` and paste in the Project URL and "anon public" key from
   Project Settings → API. (Or skip this file entirely and paste them into the one-time setup
   screen the site shows itself when it isn't connected yet — handy for testing before you commit
   to a file change.)
5. **Deploy to Cloudflare Pages**: push this folder to a GitHub repo, then in the Cloudflare
   dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the
   repo. Build settings: Framework preset **None**, build command **blank**, build output directory
   **/ (repo root)**. Every push then redeploys automatically.
6. **Update the QR code's target**: `js/config.js`'s `siteUrl` should match wherever the site actually
   ends up living (the `*.pages.dev` address, or a real domain once you have one) — the QR image
   on the "Get the app" section is generated from that value.

## How "the queue calls the next person" really works

There is no GPS or Bluetooth involved — a plain browser can't reliably detect someone walking
through a door, and pretending otherwise would be a system that quietly fails. Instead:

- A client can tap **"I'm here"** on their own booking once they've arrived (self-reported).
- Only Alfred's own **Start cut** tap actually starts a cut — he's the one who knows the chair is
  really free.
- The moment he does, the system automatically marks the *next* booked client as **called** and rings
  their phone (if their tab/app is open) — that's the "20 minutes later, the next person is
  called" behaviour, driven by the real event (this cut starting) rather than a rigid timer that
  can't tell a quick trim from a longer cut with dye.
- If a called client never checks in, **No-show** in the owner panel frees their slot for a walk-in or
  anyone else — exactly the "be there or lose it" rule that was asked for.

## Project layout

```
index.html            public site: queue, booking, my booking, reviews, chat, contact, get-app
admin.html / js/admin.js   owner panel: queue control, all bookings, reviews, messages, shop details
js/app.js              public site logic
js/config.js            Supabase URL/key (safe to publish — real security is in the database)
js/lib/db.js            thin Supabase client wrapper
js/lib/slots.js          20-minute slot math
js/lib/client.js         this browser's private booking token
js/lib/ringtone.js       the "you're up next" alert (Web Audio, no audio file)
css/style.css            the whole design (charcoal + gold)
manifest.webmanifest, sw.js, icons/icon.svg   installable app / PWA
supabase/schema.sql      the entire database: tables, row-level security, every function
```

## Known follow-ups

- `icons/icon.svg` is a plain placeholder monogram — swap in Alfred's real logo/photo once he has
  one (a PNG works fine alongside or instead of the SVG in `manifest.webmanifest`).
- Reviews are held for approval (`is_public = false` until Alfred publishes them from the owner
  panel) so nothing goes live unmoderated.
