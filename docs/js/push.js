/**
 * push.js — opting in to the "you left a workout running" reminder.
 *
 * The only part of Plates that is not local-first. A push subscription belongs
 * to one installed browser and is meaningless anywhere else, so there is nothing
 * to sync and nothing worth keeping offline — it goes straight to Postgres.
 *
 * Permission is never requested on load. A notification prompt that appears
 * before you have asked for anything is the fastest way to get denied
 * permanently, and denied is not recoverable from script.
 */

import { db, supabase } from './supabase.js';

/**
 * The VAPID public key, read from the server rather than hardcoded.
 *
 * It identifies this application to the push service and is public by design —
 * the private half lives in plates.app_config where only the service role can
 * see it. Fetched rather than pinned because the Edge Function generates the
 * pair itself: hardcoding the public half meant that if the private half was
 * ever lost, every existing subscription became undeliverable with nothing in
 * the app able to notice.
 */
let cachedKey = null;

async function serverKey() {
  if (cachedKey) return cachedKey;

  const { data, error } = await db('app_config')
    .select('value')
    .eq('key', 'vapid_public_key')
    .maybeSingle();

  if (error) throw error;
  if (!data?.value) {
    throw new Error('Reminders are not set up on the server yet. Try again in a few minutes.');
  }

  cachedKey = data.value;
  return cachedKey;
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const b64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function isSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** 'default' | 'granted' | 'denied' | 'unsupported' */
export function permission() {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

/** Whether this browser already has a live subscription. */
export async function isSubscribed() {
  if (!isSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return Boolean(await reg.pushManager.getSubscription());
}

/**
 * Make sure a granted permission is actually backed by a live subscription.
 *
 * Permission and subscription are separate things, and only the permission
 * survives on its own. A subscription can be missing because the browser dropped
 * it, because the server's key rotated, or — as happened here — because its row
 * was deleted server-side. Nothing then re-created it: healSubscription only
 * repairs a subscription that already exists, and enable() only runs from a tap,
 * so a granted permission sat there with nothing to push to and no notification
 * ever arrived.
 *
 * Silent and safe to call on every load: it never prompts, because it does
 * nothing at all unless permission is already granted.
 *
 * @returns {Promise<'granted-and-subscribed'|'no-permission'|'unsupported'|'failed'>}
 */
export async function ensureSubscribed() {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'no-permission';

  try {
    const reg = await navigator.serviceWorker.ready;
    const key = await serverKey();
    const existing = await reg.pushManager.getSubscription();

    // Bound to a key the server no longer signs with: unusable, so replace it.
    if (existing) {
      const boundTo = existing.options?.applicationServerKey;
      if (boundTo && b64(boundTo) !== key) {
        await db('push_subscriptions').delete().eq('endpoint', existing.endpoint);
        await existing.unsubscribe();
      } else {
        // Upsert regardless — the row may be missing even though the browser
        // still holds the subscription.
        await save(existing);
        return 'granted-and-subscribed';
      }
    }

    await save(await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));
    return 'granted-and-subscribed';
  } catch {
    // Offline, or the key is not published yet. Nothing worth interrupting for.
    return 'failed';
  }
}

/**
 * Re-subscribe if the server's key has moved on.
 *
 * A subscription is bound to the key it was created with, and `subscribe()`
 * throws rather than replacing one made with a different key — so a rotated
 * keypair would otherwise leave a subscription that can never be delivered to
 * and no way to notice. Silent: permission is already granted, so there is no
 * prompt and nothing to tell the user about.
 */
export async function healSubscription() {
  if (!isSupported() || Notification.permission !== 'granted') return false;

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (!existing) return false;

  const current = await serverKey();
  const boundTo = existing.options?.applicationServerKey;
  if (boundTo && b64(boundTo) === current) return false;

  await db('push_subscriptions').delete().eq('endpoint', existing.endpoint);
  await existing.unsubscribe();
  await save(await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(current),
  }));

  return true;
}

/**
 * Ask, subscribe, and record the endpoint.
 *
 * Must be called from a user gesture — browsers ignore a permission request
 * that did not come from a click.
 *
 * @returns {Promise<'granted'|'denied'|'unsupported'>}
 */
export async function enable() {
  if (!isSupported()) return 'unsupported';

  const granted = await Notification.requestPermission();
  if (granted !== 'granted') return granted;

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    ?? await reg.pushManager.subscribe({
      // Required by Chrome: every push must result in something the user sees.
      // Which is true here anyway — this exists to show one notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(await serverKey()),
    });

  await save(sub);
  return 'granted';
}

/** Stop the reminders, on this browser, and drop the endpoint server-side. */
export async function disable() {
  if (!isSupported()) return;

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await db('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

/**
 * Upsert on `endpoint`, because a browser hands back the same subscription on
 * every call — inserting would collide on the unique index the second time.
 */
async function save(sub) {
  const raw = sub.toJSON?.() ?? {};
  const keys = raw.keys ?? {};

  const { data: { user } } = await supabase.auth.getUser();

  const { error } = await db('push_subscriptions').upsert({
    owner_email: user?.email,
    endpoint: sub.endpoint,
    p256dh: keys.p256dh ?? b64(sub.getKey('p256dh')),
    auth: keys.auth ?? b64(sub.getKey('auth')),
    user_agent: navigator.userAgent.slice(0, 300),
    failed_at: null,          // a re-subscribe revives an endpoint we gave up on
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });

  if (error) throw error;
}

// ---- preferences ------------------------------------------------------------
//
// What to send, as opposed to whether this browser can be sent to at all. The
// subscription is per-installed-browser; these are per-person, so they live in
// Postgres and the Edge Functions read them directly. Not local-first for the
// same reason as the rest of this file: a preference the server cannot see is a
// preference the server cannot act on.

/** Server defaults, mirrored so the UI has something to draw before the fetch. */
export const DEFAULT_PREFS = { idle_workouts: true, morning_quotes: false };

/**
 * This person's settings, creating the row on first read.
 *
 * Upsert rather than select-then-insert: two tabs opening at once would both see
 * no row and both insert, and the second would collide on the primary key.
 */
export async function loadPrefs(ownerEmail) {
  const { data, error } = await db('notification_prefs')
    .upsert({ owner_email: ownerEmail, ...DEFAULT_PREFS }, { onConflict: 'owner_email', ignoreDuplicates: true })
    .select('idle_workouts, morning_quotes')
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  // ignoreDuplicates returns nothing when the row already existed.
  const { data: existing, error: readError } = await db('notification_prefs')
    .select('idle_workouts, morning_quotes')
    .eq('owner_email', ownerEmail)
    .maybeSingle();

  if (readError) throw readError;
  return existing ?? { ...DEFAULT_PREFS };
}

export async function savePrefs(ownerEmail, changes) {
  const { data, error } = await db('notification_prefs')
    .upsert({ owner_email: ownerEmail, ...changes, updated_at: new Date().toISOString() },
      { onConflict: 'owner_email' })
    .select('idle_workouts, morning_quotes')
    .maybeSingle();

  if (error) throw error;
  return data ?? { ...DEFAULT_PREFS, ...changes };
}
