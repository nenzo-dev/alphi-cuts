// push-send: sends AlPhi Cuts notifications to phones and computers, even when the site is closed.
//
// The database queues each notification in push_outbox (supabase/migrations/13_push_notifications.sql)
// and calls this function the moment it does, and once a minute in case a call was missed. Each run
// takes the waiting notifications (push_take), encrypts each one for the device it goes to
// (RFC 8291, aes128gcm), signs the request with the shop's key (VAPID, RFC 8292) and hands it to that
// device's push service: Google, Mozilla, Apple or Microsoft. Devices the push service says are gone
// are forgotten (push_forget).
//
// The signing keys are made here the first time this runs and kept in the database (push_keys), so
// no secret is ever copied by hand. Calling this function only sends what the database has queued,
// so it's safe for the database to call it with the public anon key.
//
// Written in plain JavaScript (which is also valid TypeScript), so the encryption can be checked
// outside Deno against the example in RFC 8291.

const SUBJECT = 'https://alphi-cuts.pages.dev/'; // who to contact about these notifications (VAPID "sub")
const RECORD_SIZE = 4096;

const enc = (s) => new TextEncoder().encode(s);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(text).length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * Encrypts one message for one device (RFC 8291). `fixed` is only for checking against the RFC's
 * example: a known salt and server key pair instead of fresh random ones.
 */
export async function encryptPayload(text, p256dh, authSecret, fixed = null) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const server = fixed ? fixed.keys : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));

  const ikm = await hkdf(auth, shared, concat(enc('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc(text), new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/** The signed token that proves the request comes from this shop's server (RFC 8292). */
export async function vapidToken(audience, privateKey, subject = SUBJECT) {
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc(`${head}.${claims}`)));
  return `${head}.${claims}.${b64u(signature)}`;
}

// ------------------------------------------------------------------ talking to the database
function env(name) {
  return typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined;
}

// The project's server key: the classic service_role key, or one of the newer secret keys.
function serverKey() {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default || Object.values(keys)[0];
  } catch {
    return undefined;
  }
}

async function rpc(name, args = {}) {
  const url = env('SUPABASE_URL');
  const key = serverKey();
  // A newer secret key (sb_secret_...) goes in the apikey header only; a classic key is also a JWT.
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!String(key).startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`${name} answered ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** The shop's signing keys, made the first time and kept in the database after that. */
async function signingKeys() {
  let rows = await rpc('push_keys_get');
  if (!rows || !rows.length) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    rows = await rpc('push_keys_init', { p_public_key: publicKey, p_private_jwk: privateJwk });
  }
  const row = rows[0];
  const jwk = { ...row.private_jwk, key_ops: ['sign'], ext: false };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publicKey: row.public_key, privateKey };
}

async function deliver(row, keys, tokens) {
  const origin = new URL(row.endpoint).origin;
  if (!tokens.has(origin)) tokens.set(origin, await vapidToken(origin, keys.privateKey));
  const message = JSON.stringify({ title: row.title, body: row.body, url: row.url, tag: row.tag, urgent: row.urgent });
  const res = await fetch(row.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${tokens.get(origin)}, k=${keys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: row.urgent ? '900' : '3600',
      Urgency: row.urgent ? 'high' : 'normal',
    },
    body: await encryptPayload(message, row.p256dh, row.auth),
  });
  await res.body?.cancel();
  return res.status;
}

async function run() {
  const keys = await signingKeys();
  const tokens = new Map();
  const gone = [];
  let sent = 0;
  let failed = 0;
  for (let round = 0; round < 5; round += 1) {
    const rows = (await rpc('push_take', { p_limit: 200 })) || [];
    if (!rows.length) break;
    await Promise.all(rows.map(async (row) => {
      try {
        const status = await deliver(row, keys, tokens);
        if (status === 404 || status === 410) gone.push(row.endpoint);
        else if (status >= 200 && status < 300) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }));
  }
  if (gone.length) await rpc('push_forget', { p_endpoints: [...new Set(gone)] });
  return { sent, failed, gone: gone.length };
}

if (typeof Deno !== 'undefined') {
  Deno.serve(async () => {
    try {
      return Response.json(await run());
    } catch (err) {
      console.error(err);
      return Response.json({ error: 'push-send failed' }, { status: 500 });
    }
  });
}
