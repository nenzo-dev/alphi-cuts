// A small fetch-based client for the Supabase REST, RPC and Storage endpoints. The public pages
// only need these few calls, so they don't have to download the full supabase-js library first.
import { CONFIG } from '../config.js';

const BASE = CONFIG.supabase.url;
const KEY = CONFIG.supabase.anonKey;
const TIMEOUT_MS = 20000;

// The owner panel plugs in a function that returns the signed-in owner's access token.
let getAccessToken = null;
export function setAccessTokenGetter(fn) { getAccessToken = fn; }

export class ApiError extends Error {
  constructor(status, body) {
    super(body && body.message ? String(body.message) : `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body && body.code ? String(body.code) : '';
    // Errors raised on purpose in our database functions (SQLSTATE P0001) are written for people
    // to read. Anything else is internal and never shown on the page.
    this.userMessage = this.code === 'P0001' ? this.message : null;
  }
}

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  let token = null;
  if (getAccessToken) {
    try { token = await getAccessToken(); } catch { token = null; }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, ...headers },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) throw new ApiError(res.status, data && typeof data === 'object' ? data : null);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function rpc(name, args = {}) {
  return request(`/rest/v1/rpc/${name}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(args) });
}

export function select(table, query) {
  return request(`/rest/v1/${table}?${query}`);
}

// True when the database doesn't have this function (yet). Lets the site keep working on a
// database that hasn't had the latest migration applied.
export function isMissingFunction(err) {
  return err instanceof ApiError && (err.code === 'PGRST202' || err.status === 404);
}

// Calls a function, or runs `fallback` if the database doesn't have it. A miss is remembered so
// polling doesn't ask again every few seconds.
const missing = new Set();
export async function rpcOr(name, args, fallback, key = name) {
  if (missing.has(key)) return fallback();
  try {
    return await rpc(name, args);
  } catch (err) {
    if (!isMissingFunction(err)) throw err;
    missing.add(key);
    return fallback();
  }
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function publicFileUrl(bucket, path) {
  return `${BASE}/storage/v1/object/public/${bucket}/${encodePath(path)}`;
}

export function uploadFile(bucket, path, file) {
  const form = new FormData();
  form.append('cacheControl', '3600');
  form.append('', file);
  return request(`/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: 'POST', headers: { 'x-upsert': 'false' }, body: form,
  });
}

export function removeFiles(bucket, paths) {
  if (!paths.length) return Promise.resolve(null);
  return request(`/storage/v1/object/${bucket}`, {
    method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ prefixes: paths }),
  });
}

export async function signedFileUrl(bucket, path, expiresIn = 600) {
  const data = await request(`/storage/v1/object/sign/${bucket}/${encodePath(path)}`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ expiresIn }),
  });
  return encodeURI(`${BASE}/storage/v1${data.signedURL}`);
}
