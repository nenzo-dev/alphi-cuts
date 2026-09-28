// Site-wide settings. Everything here is safe to publish (no secrets) -- the Supabase anon key is
// designed to be public; every real permission check happens in the database (row-level security
// and the SECURITY DEFINER functions in supabase/schema.sql), never in this file.
//
// Paste your Supabase Project URL and "anon public" key below (Supabase dashboard -> Project
// Settings -> API) once you've created the project and run supabase/schema.sql in its SQL editor.
// Until then, the app shows a one-time setup screen where you can paste them in instead, kept in
// this browser only -- handy for trying the site before editing this file.
const SUPABASE = {
  url: '',
  anonKey: '',
};

function savedSetup() {
  try {
    const b = JSON.parse(localStorage.getItem('ac_bootstrap') || 'null');
    if (b && /^https:\/\/[\w.-]+$/.test(b.url || '') && typeof b.anonKey === 'string' && b.anonKey.length > 20) return b;
  } catch { /* storage unavailable */ }
  return null;
}
const chosen = SUPABASE.url && SUPABASE.anonKey ? SUPABASE : savedSetup();

export const CONFIG = {
  shortName: 'AlPhi Cuts',
  fullName: "AlPhi Cuts — Alfred Phiri's Barbershop",
  siteUrl: 'https://alphicuts.pages.dev/',
  supabase: chosen ? { url: chosen.url.replace(/\/+$/, ''), anonKey: chosen.anonKey } : { url: '', anonKey: '' },
};

export function saveBootstrap(url, anonKey) {
  try { localStorage.setItem('ac_bootstrap', JSON.stringify({ url, anonKey })); } catch { /* ignore */ }
}
