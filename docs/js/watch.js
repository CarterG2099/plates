/**
 * watch.js — the phone's half of pairing a watch.
 *
 * The watch can't do the Google sign-in, so the signed-in phone asks the
 * watch-pair function for a one-time code and shows it; the watch types it and
 * gets a session of its own. See supabase/functions/watch-pair.
 */

import { supabase } from './supabase.js';

export async function createPairing() {
  if (!navigator.onLine) throw new Error('Pairing needs a connection.');

  const { data, error } = await supabase.functions.invoke('watch-pair', { body: { action: 'create' } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return { code: data.code, expiresAt: data.expires_at };
}

/** "48151623" → "4815 1623": two halves are easier to carry to a watch. */
export function formatCode(code) {
  const s = String(code ?? '');
  return s.length === 8 ? `${s.slice(0, 4)} ${s.slice(4)}` : s;
}

/** "until 3:42 PM" — a clock time, so nothing has to tick down on screen. */
export function expiryLabel(expiresAt) {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return '';
  return `until ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
