// Default wording for the privacy policy, terms of use and disclaimer. The owner can replace any
// of them from the panel (Legal pages tab). {shop}, {owner}, {owner_first} and {slot} are filled in
// from the shop's settings.
export const LEGAL_UPDATED = '30 September 2026';

export const LEGAL_DOCS = {
  privacy: {
    title: 'Privacy policy',
    text: `# Privacy policy

Last updated: ${LEGAL_UPDATED}

This page explains what {shop} collects through this website, why we collect it, and what we do with it.

## What we collect

- **Bookings:** your name, phone number, the day and time you picked, the style you chose, and how the booking went (for example checked in, done or cancelled).
- **Chat:** the messages you send us and our replies.
- **Style requests:** the description you write and any photo you upload.
- **Reviews:** the name you give (optional), your rating and your comment.
- **Online payments:** whether you asked to pay online and whether the payment was approved and received. We never ask for card numbers or mobile money PINs. You pay us directly.
- **On your device:** the site keeps a few random codes in your browser so it can show your own booking and chat. They don't contain your name or number. Clearing your browser data removes them, but you'll no longer see your booking on that device.

We don't use advertising or tracking cookies, and we never sell your information.

## The Android app

The app shows this same website, so everything on this page applies to it. On top of that:

- It keeps your booking time and the private code for each booking on your phone, so it can set alarms for them.
- On the day of a booking, from about two hours before your slot until it ends, it checks your booking and any replies from the shop every so often, even when the app is closed. While it does this, Android shows a "Keeping an eye on your booking" notification.
- It asks to show notifications, set alarms, show a full-screen alert when it's your turn, and run in the background. You can turn any of these off in your phone's settings, but alerts may then not work.

The app has no ads or trackers, and it doesn't use your contacts, location, camera or microphone. It only reads a photo if you choose one to send with a style request. Uninstalling the app deletes everything it stored on your phone.

## Why we use it

- To hold your slot and run the queue
- To call or message you about your booking
- To answer your questions in the chat
- To show published reviews on the site

## Who can see it

Only the shop owner, and any co-owner they add, can see names, phone numbers, messages and photos, through a password-protected owner panel. The public queue only shows times, never names. A published review shows the name you gave with it.

The information is stored with Supabase, our database provider, and the site is delivered by Cloudflare. They handle it for us only to run this service.

## How long we keep it

- A cancelled booking is deleted straight away. The only exception is a booking you had already paid for online, which we keep so the payment can be traced.
- A missed booking is deleted the day after.
- All other bookings and chat messages are deleted automatically after {keep_days} days.
- Style requests, and any photo sent with one, are deleted after about {keep_days} days.

You can ask us to delete your information sooner at any time.

## Your rights

Under Zambia's Data Protection Act, 2021, you can ask to see the information we hold about you, ask us to correct it, or ask us to delete it. Call us on the number on the home page or send a message through the chat.

## Changes

If we change this policy we'll update the date at the top of this page.`,
  },

  terms: {
    title: 'Terms of use',
    text: `# Terms of use

Last updated: ${LEGAL_UPDATED}

By using this website or booking a slot with {shop}, you agree to these terms.

## Bookings

- A booking holds one {slot}-minute slot for one person.
- Please arrive a few minutes early. If you're not at the shop when it's your turn, your slot may go to the next person and be marked as a no-show.
- Times are a guide. A cut can run a little early or late, especially if the person before you needs more time.
- If you can't make it, cancel from "My booking" so someone else can have the slot.
- We may cancel or move a booking if something comes up at the shop. We'll try to reach you on the number you gave.
- Please use your real name and a working phone number. Fake or repeated bookings may be cancelled.

## Prices and payment

- Prices are in Zambian kwacha and may change.
- You can always pay at the shop.
- Online payment is only possible once {owner_first} approves it for your booking. Only send money to the details shown on your own booking after approval.
- Refunds for online payments are handled directly with the shop.

## Reviews, chat and photos

- Reviews are checked before they're published. We may decline or remove reviews that are abusive, false or off-topic.
- Don't send anything abusive or illegal, and only upload photos you have the right to share.
- Photos sent with a style request are only seen by the shop.

## Using the site

- Don't try to break, overload or misuse the site, or get at information that isn't yours.
- We may change or pause parts of the site, including online booking, at any time.

## The Android app

- Only install the app from this website. A copy from anywhere else may not be genuine.
- When the app says a new version is ready, please update it.
- These terms apply to the app too. We may change or stop offering the app at any time.

## Liability

We work to keep the site accurate and running, but it's provided as it is. {shop} isn't responsible for losses caused by the site being unavailable, by delays in the queue, or by payments made outside the process described above. Nothing in these terms takes away rights you have under Zambian law.

## Contact

Questions about these terms? Call us or send a message through the chat.`,
  },

  disclaimer: {
    title: 'Disclaimer',
    text: `# Disclaimer

Last updated: ${LEGAL_UPDATED}

## Styles and photos

The photos in the style gallery show what each style looks like. Some are examples rather than cuts done at {shop}. How a style turns out depends on your hair type, length and texture, so your cut may look different.

## Hair dye and products

Hair dye and some hair products can cause allergic reactions. If you have sensitive skin, or have reacted to dye before, tell {owner_first} before your cut. A patch test beforehand is a good idea.

## Queue, times and alerts

The queue and times on this site depend on the shop keeping them up to date, so treat them as a guide.

The Android app rings when your slot starts even when the app is closed, as long as you allow its notifications, alarms and background use. Some phones' battery savers can still stop it, and the sound follows your phone's alarm volume. On iPhone and in a web browser, alerts only work while this site is open; adding your booking to your calendar is the most reliable reminder there. Please keep an eye on the time yourself.

## Payments

Only pay online after your booking shows the payment details as approved, and only for that booking. {shop} is not responsible for money sent to other numbers or accounts, or sent before approval.

## Ratings and reviews

The overall rating at the top of the page is provided by the shop. Individual reviews come from customers and are checked before they're published.

## Other websites

Links to WhatsApp, Facebook or Instagram take you to services with their own terms and privacy policies.`,
  },
};
