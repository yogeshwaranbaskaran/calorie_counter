// Shell cached so the app opens instantly and survives a flaky connection.
// API calls always go to the network - a stale food log would be worse than none.
const CACHE = 'health-v1'
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api/')) return
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})
