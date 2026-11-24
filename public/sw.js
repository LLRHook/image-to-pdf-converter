/*
 * Service worker: offline cache + egress firewall.
 *
 *  - Anything that is not a GET to this site's own origin is refused. Nothing
 *    in this app ever uploads, so a POST/PUT or a cross-origin request can
 *    only be a bug or something unwanted; it fails here.
 *  - App files and engines (wasm) are cached so they load offline and don't
 *    re-download. Only this site's own files are ever cached. User files are
 *    never fetched over the network, so they can never end up in this cache.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `app-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || req.method !== 'GET') {
    event.respondWith(Response.error());
    return;
  }
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const isHashed = /\/assets\//.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (!isPage) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok && (isHashed || isPage || url.pathname.endsWith('asset-sizes.json'))) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
