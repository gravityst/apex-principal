/**
 * APEX: Principal — offline shell.
 *
 * Pinned to a home screen the game has to open on a plane, in a car park, on a
 * train through a tunnel. Everything it needs is static, so the whole thing is
 * cached on first run and served from disk after that. Bump CACHE to ship an
 * update; the old cache is deleted on activate and the new worker takes over
 * immediately rather than waiting for every tab to close.
 */
const CACHE = 'apex-principal-v3';

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './styles/principal.css',
  './icons/apex-180.png', './icons/apex-192.png', './icons/apex-512.png', './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // One missing file must not fail the whole install.
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: instant from cache, fresh copy for next time.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response('offline', { status: 503 });
  })());
});
