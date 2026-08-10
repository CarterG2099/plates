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
 * The VAPID public key, which identifies this application to the push service.
 * Public by design — it is the counterpart of a private key held only in the
 * Edge Function's secrets, and on its own it grants nothing.
 */
const VAPID_PUBLIC_KEY =
  'BLiq_z-L2IL1vk34HFy48E9h1jjFzRdC_FIcoYViHB3LOJE-5SsdDCMm7Onf9MLIHf7UiDi6ndMsPvmUf4Pic2k';

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
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
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
