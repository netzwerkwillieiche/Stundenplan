const CACHE = 'stundenplan-v1';
const SHELL = ['/', '/index.html', '/style.css', '/manifest.webmanifest', '/icon-192.png',
  '/app.js', '/start.js', '/kern.js', '/login.js', '/plan.js', '/freunde.js', '/chat.js',
  '/hausaufgaben.js', '/profil.js', '/admin.js', '/kalender.js', '/tickets.js', '/emoji.js', '/raumplan.js',
  '/menue.js', '/buero.js', '/freigabe.js', '/umfragen.js', '/umfrage-logik.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // /api/ niemals cachen: die App zeigt sonst nach einem Deploy alte Stundenplaene, und
  // angemeldete Antworten haetten auf einem geteilten Handy nichts im Cache verloren.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Network-first: nach einem Deploy ist sofort die neue Version da, der Cache ist nur das
  // Offline-Netz darunter.
  e.respondWith(fetch(e.request)
    .then(res => {
      // Nur Erfolge: eine 404- oder 500-Seite im Cache waere offline die "App".
      if (res.ok) {
        const kopie = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, kopie));
      }
      return res;
    })
    .catch(() => caches.match(e.request)
      .then(treffer => treffer ?? (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined))));
});

// --- Benachrichtigungen ------------------------------------------------------
// Der Push kommt ohne Inhalt (siehe push.js): er sagt nur "da ist was". Den Text holen wir hier
// angemeldet ab - beim Ende-zu-Ende-Chat koennte der Server ihn ohnehin nicht mitschicken.

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let offen = [];
    try {
      const res = await fetch('/api/notifications/pending', { credentials: 'include' });
      if (res.ok) offen = await res.json();
    } catch { /* offline - beim naechsten Anstupsen wieder */ }

    if (!offen.length) {
      // Ohne Anzeige verliert die App in manchen Browsern die Push-Erlaubnis. Lieber etwas
      // Unbestimmtes zeigen als gar nichts.
      return self.registration.showNotification('Stundenplan', { body: 'Es gibt etwas Neues.', tag: 'sammel' });
    }
    for (const n of offen) {
      await self.registration.showNotification(n.title, {
        body: n.body ?? '',
        tag: `${n.kind}-${n.id}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: n.url || '/' },
      });
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const ziel = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    // Ein schon offenes Fenster in den Vordergrund holen, statt ein zweites aufzumachen.
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenster) if (new URL(f.url).origin === location.origin) return f.focus();
    return self.clients.openWindow(ziel);
  })());
});
