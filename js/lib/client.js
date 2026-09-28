// The client's own booking "ticket": a random token the database hands back from book_slot() or
// send_message(), kept in this browser only. Whoever holds it can see and manage that one booking
// or chat thread -- there is no account, no password, nothing else to lose or forget.
const KEY = 'ac_client_token';

export function getClientToken() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}
export function setClientToken(token) {
  try { localStorage.setItem(KEY, token); } catch { /* ignore */ }
}
export function clearClientToken() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
