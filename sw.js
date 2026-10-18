// PromemoriaMio Service Worker v1.0
// Gestisce notifiche locali programmate

const CACHE_NAME = 'promemoriamio-v55';
const ASSETS = ['./index.html', './manifest.json'];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // NON skipWaiting qui — vogliamo che il nuovo SW resti in "waiting"
  // così la pagina mostra il banner giallo e l'utente sceglie quando aggiornare
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch (cache-first per assets, network-first altrimenti) ─────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Notifiche programmate ─────────────────────────────────────────────────────
const timers = new Map();

function cancellaTimer(tag) {
  if (timers.has(tag)) {
    clearTimeout(timers.get(tag));
    timers.delete(tag);
  }
}

function programmaNotifica({ tag, title, body, timestamp }) {
  cancellaTimer(tag);
  const delay = timestamp - Date.now();
  if (delay <= 0) return;

  const id = setTimeout(async () => {
    timers.delete(tag);
    try {
      await self.registration.showNotification(title || 'PromemoriaMio', {
        body: body || 'Hai un impegno in programma',
        tag,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        silent: false,
        renotify: true,
        requireInteraction: false,
        data: { url: './' }
      });
    } catch (err) {
      console.warn('[SW] showNotification error:', err);
    }
  }, delay);

  timers.set(tag, id);
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || !msg.tipo) return;

  switch (msg.tipo) {
    case 'SCHEDULE_NOTIFICHE': {
      for (const [tag] of timers) cancellaTimer(tag);
      const lista = Array.isArray(msg.notifiche) ? msg.notifiche : [];
      lista.forEach(n => {
        if (n.tag && n.title && n.timestamp) programmaNotifica(n);
      });
      break;
    }
    case 'CANCEL_NOTIFICA': {
      if (msg.tag) {
        cancellaTimer(msg.tag);
        self.registration.getNotifications({ tag: msg.tag })
          .then(ns => ns.forEach(n => n.close()));
      }
      break;
    }
    case 'PING': {
      e.source && e.source.postMessage({ tipo: 'PONG', timers: [...timers.keys()] });
      break;
    }
    case 'SKIP_WAITING': {
      self.skipWaiting();
      break;
    }
  }
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || './';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        const client = clients[0];
        client.postMessage({ tipo: 'NOTIFICA_IN_ARRIVO' });
        if ('focus' in client) return client.focus();
      } else {
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      }
    })
  );
});
