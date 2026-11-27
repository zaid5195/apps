// Offline app shell for phone mode. API calls and project files are never cached.
const CACHE = 'reel-studio-v2';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  const isAsset = /\/assets\/|\/vendor\//.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isAsset) { const hit = await cache.match(e.request); if (hit) return hit; }
    // Code is revalidated on every load (cache: 'no-cache') so app.js, core/*.js and app.css never mix versions.
    try { const r = await fetch(e.request, { cache: isAsset ? 'default' : 'no-cache' }); if (r.ok) cache.put(e.request, r.clone()); return r; }
    catch { const hit = await cache.match(e.request); if (hit) return hit; throw new Error('offline'); }
  })());
});
