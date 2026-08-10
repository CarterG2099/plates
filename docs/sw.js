/**
 * sw.js — offline shell.
 *
 * Local-first data is worthless if the app that reads it needs the network to
 * load. This caches the shell so a cold start in a gym with no signal still
 * opens.
 *
 * ── Bump CACHE_VERSION whenever a precached file changes. ────────────────────
 * Nothing else invalidates the cache. Forgetting means users keep an old shell.
 *
 * Deliberate choices, several of them learned from budget's service worker
 * (which reached v9 and eventually gave up on caching anything but icons):
 *
 * - **Navigations are network-first.** Cache-first HTML is how a deploy fails to
 *   land and you spend an afternoon wondering why. Offline falls back to cache.
 * - **Same-origin code is network-first**, like navigations. Stale-while-
 *   revalidate was tried and was a mistake: it serves the *previous* build on
 *   every load and fetches the new one for next time, so a fresh index.html can
 *   pair with month-old JS. That produced real bugs — missing functions
 *   rendering as "undefined" — that looked like application faults. A handful of
 *   small files are not worth that class of confusion.
 * - **Vendor and icons stay stale-while-revalidate**, because they're version-
 *   pinned and genuinely don't change.
 * - **Supabase and Open Food Facts are never intercepted.** Caching auth tokens
 *   or API responses would be actively harmful; those either reach the network
 *   or fail honestly, and the app already handles failing honestly.
 * - **Only GET.** A cached POST would be a silent data-loss bug.
 *
 * Budget's worker notes that Safari has had trouble when a service worker
 * intercepts ES module imports. That was the reason it stopped caching scripts.
 * This one does cache them, because offline is a hard requirement here rather
 * than a nice-to-have — if module loading ever misbehaves on iOS, the fix is to
 * add a `request.destination === 'script'` bail-out in `onFetch`, not to rework
 * the whole strategy.
 */

const CACHE_VERSION = 'plates-v45';

/** The shell. Everything needed to open the app and read local data. */
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/pages.css',
  '/js/app.js',
  '/js/supabase.js',
  '/js/local.js',
  '/js/sync.js',
  '/js/food.js',
  '/js/lookup.js',
  '/js/scanner.js',
  '/js/photo.js',
  '/js/workout.js',
  '/js/muscle-map.js',
  '/js/import-hevy.js',
  '/js/stats.js',
  '/js/vendor/alpine.esm.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

/**
 * supabase-js comes from a CDN, and app.js reads `window.supabase` at module
 * load — so without this, an offline cold start dies before rendering anything.
 * Cached separately because a CDN hiccup must not fail the whole install.
 */
const VENDOR = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.107.0/dist/umd/supabase.js',
];

/** Hosts that must always talk to the network, never the cache. */
const NEVER_CACHE = ['supabase.co', 'openfoodfacts.org', 'nal.usda.gov'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(SHELL);

    for (const url of VENDOR) {
      try {
        await cache.add(new Request(url, { mode: 'cors' }));
      } catch {
        // Offline install, or the CDN is down. The app still works online; it
        // just won't have this cached until the next successful visit.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (NEVER_CACHE.some((host) => url.hostname.endsWith(host))) return;

  // Page loads: fresh if possible, cached if not.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, true));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isVendor = VENDOR.includes(url.href);

  // Pinned or immutable: serve instantly, refresh behind the scenes.
  if (isVendor || /\.(png|jpg|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Our own code: correct beats fast. Offline still falls back to the cache.
  if (sameOrigin) {
    event.respondWith(networkFirst(request));
  }
});

/**
 * @param {boolean} indexFallback  only for navigations. Falling back to the page
 *   for *any* request would hand HTML to a <script> tag, turning an offline miss
 *   into a syntax error.
 */
async function networkFirst(request, indexFallback = false) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return indexFallback ? (await cache.match('/index.html')) ?? Response.error() : Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      // Opaque responses have status 0 and would poison the cache.
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached ?? (await network) ?? Response.error();
}

/** Lets the page force an update without waiting for a reload cycle. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
