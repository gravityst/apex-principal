/**
 * APEX: Principal — offline shell.
 *
 * Pinned to a home screen the game has to open on a plane, in a car park, on a
 * train through a tunnel. Everything it needs is static, so the whole thing is
 * cached on first run and served from disk after that. Bump CACHE to ship an
 * update; the old cache is deleted on activate and the new worker takes over
 * immediately rather than waiting for every tab to close.
 */
const CACHE = 'apex-principal-v5';

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

  // Code is network-first; everything else is cache-first.
  //
  // This started as stale-while-revalidate for everything, which is wrong for
  // a game made of thirty ES modules. Cache eviction is per-file, so a browser
  // could hold last week's raceengine.js next to today's weekend.js and run
  // them together. Nothing errors on load — the modules import fine — but the
  // race object is missing what the newer screen expects, and a button that
  // reads it dies where it stands and simply does nothing. Two files out of
  // step is indistinguishable from a bug in the game.
  //
  // So anything executable is fetched fresh whenever the network is there, and
  // falls back to the cache only when it is not: online you always run one
  // coherent build, offline you run the last one that was whole.
  const code = /\.(?:js|mjs|css|html|webmanifest)$/.test(url.pathname)
    || url.pathname.endsWith('/')
    || req.mode === 'navigate';

  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (code) {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true }))
          || new Response('offline', { status: 503 });
      }
    }
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
      return res;
    } catch { return new Response('offline', { status: 503 }); }
  })());
});
