// The HTML is NEVER cached. Every screen in this app needs the API, so a
// cached shell cannot make it work offline - it can only serve a stale build
// after a deploy, which is exactly what happened: a slow cold start made the
// network fetch fail, the worker fell back to a cached page, and the app kept
// running an old version with no way for the user to tell.
//
// Only the icon and manifest are cached; they never change meaningfully.
const CACHE = 'calorie-static-v3'
const STATIC = ['/manifest.json', '/icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // API and every navigation go straight to the network, always.
  if (url.pathname.startsWith('/api/')) return
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) return
  if (!STATIC.includes(url.pathname)) return
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})
