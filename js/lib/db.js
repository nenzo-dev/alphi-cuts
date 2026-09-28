// A thin wrapper around the official Supabase JS client, loaded straight from a CDN as an ES module
// (no build step, no bundler -- the same "vanilla modules" approach as MindCare). Every real
// permission check lives in the database (RLS + the functions in supabase/schema.sql); this file
// just gives the rest of the app short, readable calls instead of repeating Supabase's own API shape
// everywhere.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from '../config.js';

export const hasSupabase = !!(CONFIG.supabase.url && CONFIG.supabase.anonKey);

export const supabase = hasSupabase
  ? createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// Calls a public.<name>(...) Postgres function (see supabase/schema.sql) and throws a plain Error
// with the database's own message on failure, so callers can just try/catch and show err.message.
export async function rpc(name, args = {}) {
  if (!supabase) throw new Error('This site is not connected to a database yet.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'Something went wrong.');
  return data;
}

export async function signInOwner(email, password) {
  if (!supabase) throw new Error('This site is not connected to a database yet.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message || 'Sign-in failed.');
  return data.user;
}

export async function signOutOwner() {
  if (supabase) await supabase.auth.signOut();
}

export async function currentOwner() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data && data.user ? data.user : null;
}
