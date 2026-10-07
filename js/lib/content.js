// Every piece of wording on the public page, with its default. The owner can change any of them
// from the panel (Public page tab); changes are stored in site_config.content.text and only the
// ones that differ from these defaults are saved.
//
// Placeholders in curly braces are filled in from the shop's settings, so wording stays right
// when the hours, price or slot length change.
import { fmtTime, dayName } from './slots.js';

export const PLACEHOLDERS = {
  '{shop}': 'Shop name',
  '{owner}': "Owner's full name",
  '{owner_first}': "Owner's first name",
  '{price}': 'Price, e.g. K50',
  '{open}': 'Opening time, e.g. 9am',
  '{close}': 'Closing time, e.g. 8pm',
  '{slot}': 'Minutes per slot',
  '{days}': 'How many days ahead people can book',
  '{closed_note}': 'e.g. " Closed on Sundays." (empty when open every day)',
};

export const SECTIONS = [
  { id: 'styles', label: 'Styles gallery' },
  { id: 'queue', label: "Today's queue" },
  { id: 'book', label: 'Booking form (hiding it also pauses online booking)' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'chat', label: 'Chat' },
  { id: 'contact', label: 'Find us' },
  { id: 'get-app', label: 'Get the app' },
];

export const TEXT_GROUPS = [
  {
    title: 'Menu and top of the page',
    keys: {
      nav_styles: ['Menu: styles', 'Styles'],
      nav_queue: ['Menu: queue', 'Queue'],
      nav_book: ['Menu: booking', 'Book'],
      nav_reviews: ['Menu: reviews', 'Reviews'],
      nav_chat: ['Menu: chat', 'Chat'],
      nav_contact: ['Menu: contact', 'Find us'],
      nav_app: ['Menu: app', 'Get the app'],
      header_book: ['Header button', 'Book now'],
      hero_badge: ['Next to the rating', 'Best-rated in Chongwe'],
      hero_price: ['Price line', 'Any haircut, with or without dye: {price}'],
      hero_book: ['Main button', 'Book your slot'],
      hero_queue: ['Second button', "See today's queue"],
    },
  },
  {
    title: 'Styles',
    keys: {
      styles_title: ['Heading', 'Pick your style'],
      styles_intro: ['Intro', "Tap a style to see more photos. If you like it, we'll add it to your booking."],
      request_title: ['"Can\'t find it" heading', "Can't find your style?"],
      request_intro: ['"Can\'t find it" intro', "Describe it or send a photo so {owner_first} knows what you're after."],
      request_button: ['Send button', 'Send to {owner_first}'],
      request_sent: ['After sending', 'Got it. {owner_first} will have a look before your cut.'],
    },
  },
  {
    title: 'Queue',
    keys: {
      queue_title: ['Heading', "Today's queue"],
      queue_intro: ['Intro', 'Check how busy the shop is before you leave home.'],
      queue_free_banner: ['"Free now" banner', '{owner_first} is free right now. Walk in or book a slot.'],
      queue_notify: ['Notify button', 'Tell me when {owner_first} is free'],
      queue_full: ['No slots left', 'No free slots left today. Try booking for tomorrow.'],
      queue_closed: ['Closed today', "We're closed today. See you tomorrow."],
    },
  },
  {
    title: 'Booking',
    keys: {
      book_title: ['Heading', 'Book your slot'],
      book_intro: ['Intro', 'Open {open} to {close}. Each slot is {slot} minutes.{closed_note}'],
      book_button: ['Button', 'Book this slot'],
      book_done: ['After booking', "You're booked for {time}, {date}. Please be on time: if you're not here when it's your turn, the slot may go to the next person."],
      my_title: ['"My booking" heading', 'My booking'],
      my_empty: ['No booking yet', 'No booking on this device yet.'],
      my_alert_note: ['Alert note (website)', "Turn on notifications and we'll tell you when it's your turn, even with this site closed. You can also add the booking to your calendar."],
      my_alert_note_app: ['Alert note (Android app)', "The app rings when your slot starts, even when it's closed."],
    },
  },
  {
    title: 'Alerts',
    keys: {
      alert_reminder: ['Heads-up before the slot', 'Your cut at {shop} starts in {mins} minutes.'],
      alert_on_deck: ['Two people away', "You're 2 away at {shop}. Start heading over."],
      alert_called: ['Called next', "You're next at {shop}. Please be at the shop now."],
      alert_now: ['Slot has started', "It's your turn at {shop}. Please go to the chair now."],
      alert_arrived: ['Checked in on arrival', "You're checked in at {shop}. {owner_first} can see you're here."],
      alert_next_here: ['Next, already at the shop', "You're next at {shop}. Please don't leave. {owner_first} will call you to the chair shortly."],
    },
  },
  {
    title: 'Notifications',
    keys: {
      notify_title: ['Panel heading', 'Notifications'],
      notify_intro: ['What people get', "Get a notification on this phone when your turn is coming up, when it's your turn, and when {owner_first} replies, even when this site is closed."],
      notify_button: ['Turn on button', 'Turn on notifications'],
      notify_prompt: ['Prompt at the bottom of the page', "Never miss your turn. Turn on notifications and we'll tell you when it's time, even with this site closed."],
      notify_after_booking: ['Prompt right after booking', "You're booked. Turn on notifications and we'll tell you when it's your turn."],
      notify_on: ['When they are on', 'Notifications are on for this device.'],
      notify_free: ['"Free today" option', 'Also tell me when {owner_first} is free today'],
    },
  },
  {
    title: 'Reviews',
    keys: {
      reviews_title: ['Heading', 'What people say'],
      reviews_intro: ['Intro', 'Had a cut here? Leave a rating.'],
      reviews_empty: ['No reviews yet', 'No reviews yet. Be the first.'],
      review_form_title: ['Form heading', 'Leave a review'],
      review_thanks: ['After sending', "Thanks! Your review will show once it's approved."],
    },
  },
  {
    title: 'Chat',
    keys: {
      chat_title: ['Heading', 'Chat with {owner_first}'],
      chat_intro: ['Intro', 'Questions before you book? Send a message.'],
      chat_empty: ['No messages yet', 'No messages yet.'],
    },
  },
  {
    title: 'Find us, app and footer',
    keys: {
      contact_title: ['"Find us" heading', 'Find us'],
      app_title: ['App heading', 'Get the app'],
      app_intro: ['App intro', "Get an alert on your phone when it's your turn."],
      app_android_text: ['Android text', 'The Android app rings when your slot starts, even when the app is closed.'],
      app_android_button: ['Android download button', 'Download for Android'],
      app_ios_text: ['iPhone text', 'Open this site in Safari, tap Share, then Add to Home Screen.'],
      app_ios_note: ['iPhone note', 'On iPhone, add this site to your Home Screen (tap Share, then Add to Home Screen), open it from there and turn on notifications. They then arrive even when it is closed.'],
      app_print: ['Print button', 'Print QR code'],
      footer_note: ['Extra footer line (optional)', ''],
    },
  },
];

export const DEFAULT_TEXT = {};
export const TEXT_LABELS = {};
for (const g of TEXT_GROUPS) {
  for (const [key, [label, text]] of Object.entries(g.keys)) {
    DEFAULT_TEXT[key] = text;
    TEXT_LABELS[key] = label;
  }
}
export const OPTIONAL_TEXT = new Set(['footer_note']);

function pluralDays(list) {
  const names = list.map((n) => `${dayName(n)}s`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Values for the {placeholders}, from a normalised site_config row.
export function contentVars(cfg) {
  const owner = String(cfg.owner_name || '').trim();
  const closed = (cfg.closed_weekdays || []).slice().sort();
  return {
    shop: String(cfg.shop_name || '').trim(),
    owner,
    owner_first: owner.split(/\s+/)[0] || owner,
    price: `K${Number(cfg.price_kwacha).toFixed(0)}`,
    open: fmtTime(cfg.open_time),
    close: fmtTime(cfg.close_time),
    slot: String(cfg.slot_minutes),
    days: String(cfg.booking_days_ahead),
    closed_note: closed.length ? ` Closed on ${pluralDays(closed)}.` : '',
    address: String(cfg.address_line || ''),
    keep_days: String(cfg.keep_days || 90),
  };
}

export function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// Picks the owner's wording if set, otherwise the default, and fills in the placeholders.
export function makeText(cfg) {
  const overrides = (cfg.content && cfg.content.text) || {};
  const vars = contentVars(cfg);
  return (key, extra = {}) => {
    const raw = typeof overrides[key] === 'string' && (overrides[key].trim() || OPTIONAL_TEXT.has(key))
      ? overrides[key]
      : (DEFAULT_TEXT[key] ?? '');
    return fill(raw, { ...vars, ...extra });
  };
}

export function applyText(t, root = document) {
  for (const el of root.querySelectorAll('[data-c]')) el.textContent = t(el.dataset.c);
}
