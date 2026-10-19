// PromemoriaMio Service Worker v3.0
// Notifiche schedulate con TimestampTrigger (Chrome Android) + fallback setTimeout
// 100% locale, nessun server

const CACHE_NAME = 'promemoriamio-v81';
const ASSETS = ['./index.html', './manifest.json'];

// Feature detection: TimestampTrigger disponibile su Chrome Android
const HAS_TIMESTAMP_TRIGGER = typeof TimestampTrigger !== 'undefined';

// ── IndexedDB ─────────────────────────────────────────────────────────────────
const IDB_NAME    = 'promemoriamio-sw';
const IDB_VERSION = 4;
const IDB_STORE   = 'notifiche';

function apriDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Migrazione: elimina store vecchi
      if (db.objectStoreNames.contains('fired')) db.deleteObjectStore('fired');
      if (db.objectStoreNames.contains('notifiche')) db.deleteObjectStore('notifiche');
      db.createObjectStore(IDB_STORE, { keyPath: 'tag' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbSalva(notifica) {
  const db = await apriDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ ...notifica, status: 'pending' });
    tx.oncomplete = resolve;
    tx.onerror   = e => reject(e.target.error);
  });
}

async function idbSegnaFired(tag) {
  const db = await apriDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).get(tag);
    req.onsuccess = e => {
      if (e.target.result) {
        e.target.result.status = 'fired';
        e.target.result.firedAt = Date.now();
        tx.objectStore(IDB_STORE).put(e.target.result);
      }
      tx.oncomplete = resolve;
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function idbSegnaCancelled(tag) {
  const db = await apriDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).get(tag);
    req.onsuccess = e => {
      if (e.target.result) {
        e.target.result.status = 'cancelled';
        tx.objectStore(IDB_STORE).put(e.target.result);
      }
      tx.oncomplete = resolve;
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function idbLeggiPending() {
  const db = await apriDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = e => {
      const now = Date.now();
      resolve((e.target.result || []).filter(n =>
        n.status === 'pending' && n.timestamp > now
      ));
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function idbSvuota() {
  const db = await apriDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror   = e => reject(e.target.error);
  });
}

// Pulizia: rimuove 'fired'/'cancelled' più vecchi di 7 giorni
async function idbPulizia() {
  try {
    const db = await apriDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    req.onsuccess = e => {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      (e.target.result || []).forEach(n => {
        if ((n.status === 'fired' && n.firedAt < cutoff) ||
            (n.status === 'cancelled' && n.timestamp < cutoff)) {
          store.delete(n.tag);
        }
      });
    };
    tx.oncomplete = () => {};
  } catch (err) {
    console.warn('[SW] idbPulizia error:', err);
  }
}

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  console.log('[SW] install — HAS_TIMESTAMP_TRIGGER:', HAS_TIMESTAMP_TRIGGER);
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() => {
        // fallback setTimeout: ripristina timer solo se TimestampTrigger non disponibile
        if (!HAS_TIMESTAMP_TRIGGER) return ripristinaTimer();
      })
      .then(() => idbPulizia())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isAsset = url.origin === self.location.origin;

  e.respondWith(
    isAsset
      ? caches.match(e.request).then(c => c || fetch(e.request))
      : fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── Timer in memoria (fallback per browser senza TimestampTrigger) ────────────
const timers = new Map();

function cancellaTimer(tag) {
  if (timers.has(tag)) {
    clearTimeout(timers.get(tag));
    timers.delete(tag);
  }
}

// ── Coerce timestamp ──────────────────────────────────────────────────────────
function coerceTimestamp(ts) {
  if (typeof ts === 'string') ts = new Date(ts).getTime();
  else if (ts instanceof Date) ts = ts.getTime();
  if (typeof ts !== 'number' || isNaN(ts)) return null;
  if (ts < 1e12) ts *= 1000;  // secondi → ms
  return ts;
}

// ── Scheduling ────────────────────────────────────────────────────────────────
async function programmaNotifica({ tag, title, body, timestamp }) {
  const ts = coerceTimestamp(timestamp);
  if (!ts) {
    console.warn('[SW] timestamp non valido per', tag, ':', timestamp);
    return;
  }

  const delay = ts - Date.now();
  console.log('[SW] programmaNotifica:', tag, 'tra', Math.round(delay / 60000) + ' min',
    HAS_TIMESTAMP_TRIGGER ? '(TimestampTrigger)' : '(setTimeout fallback)');

  if (delay <= 0) return;

  await idbSalva({ tag, title, body, timestamp: ts });

  if (HAS_TIMESTAMP_TRIGGER) {
    // ── Path A: TimestampTrigger — il browser Android gestisce il timing
    try {
      await self.registration.showNotification(title || 'PromemoriaMio', {
        body: body || 'Hai un impegno in programma',
        tag,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        renotify: true,
        requireInteraction: false,
        showTrigger: new TimestampTrigger(ts),
        data: { url: './' }
      });
    } catch (err) {
      console.warn('[SW] showNotification (TimestampTrigger) error:', err);
    }
  } else {
    // ── Path B: setTimeout fallback (SW deve rimanere attivo)
    cancellaTimer(tag);
    const id = setTimeout(async () => {
      timers.delete(tag);
      await idbSegnaFired(tag);
      try {
        await self.registration.showNotification(title || 'PromemoriaMio', {
          body: body || 'Hai un impegno in programma',
          tag,
          icon: './icon-192.png',
          badge: './icon-192.png',
          vibrate: [200, 100, 200],
          renotify: true,
          requireInteraction: false,
          data: { url: './' }
        });
      } catch (err) {
        console.warn('[SW] showNotification (setTimeout) error:', err);
      }
    }, delay);
    timers.set(tag, id);
  }
}

// Fallback: al wake-up ri-schedula con setTimeout i pending (solo se no TimestampTrigger)
async function ripristinaTimer() {
  const pendenti = await idbLeggiPending();
  console.log('[SW] ripristinaTimer — pendenti:', pendenti.length);

  for (const n of pendenti) {
    const ts = coerceTimestamp(n.timestamp);
    if (!ts || ts <= Date.now()) continue;
    const delay = ts - Date.now();
    const id = setTimeout(async () => {
      timers.delete(n.tag);
      await idbSegnaFired(n.tag);
      try {
        await self.registration.showNotification(n.title || 'PromemoriaMio', {
          body: n.body || 'Hai un impegno in programma',
          tag: n.tag,
          icon: './icon-192.png',
          badge: './icon-192.png',
          vibrate: [200, 100, 200],
          renotify: true,
          requireInteraction: false,
          data: { url: './' }
        });
      } catch (err) {
        console.warn('[SW] showNotification (ripristino) error:', err);
      }
    }, delay);
    timers.set(n.tag, id);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || !msg.tipo) return;

  switch (msg.tipo) {
    case 'SCHEDULE_NOTIFICHE': {
      // Cancella timer in memoria (fallback)
      for (const [tag, id] of timers) {
        clearTimeout(id);
        timers.delete(tag);
      }
      // Chiude TUTTE le notifiche incluse quelle schedulate con trigger futuro
      self.registration.getNotifications({ includeTriggered: true })
        .then(ns => ns.forEach(n => n.close()))
        .catch(() => {
          // includeTriggered non supportato su alcuni browser — fallback senza
          return self.registration.getNotifications().then(ns => ns.forEach(n => n.close()));
        })
        .then(() => idbSvuota())
        .then(() => {
          const lista = Array.isArray(msg.notifiche) ? msg.notifiche : [];
          lista.forEach(n => {
            if (n.tag && n.title && n.timestamp) programmaNotifica(n);
          });
        });
      break;
    }
    case 'SCHEDULE_NOTIFICA': {
      const n = msg.notifica;
      if (n && n.tag && n.timestamp) programmaNotifica(n);
      break;
    }
    case 'CANCEL_NOTIFICA': {
      if (msg.tag) {
        cancellaTimer(msg.tag);
        idbSegnaCancelled(msg.tag);
        self.registration.getNotifications({ tag: msg.tag, includeTriggered: true })
          .then(ns => ns.forEach(n => n.close()))
          .catch(() => {
            return self.registration.getNotifications({ tag: msg.tag })
              .then(ns => ns.forEach(n => n.close()));
          });
      }
      break;
    }
    case 'PING': {
      e.source && e.source.postMessage({
        tipo: 'PONG',
        hasTimestampTrigger: HAS_TIMESTAMP_TRIGGER,
        timers: [...timers.keys()]
      });
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
