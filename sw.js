// PromemoriaMio Service Worker v2.0
// Gestisce notifiche locali programmate — uno store, stato esplicito

const CACHE_NAME = 'promemoriamio-v70';
const ASSETS = ['./index.html', './manifest.json'];

// ── IndexedDB ─────────────────────────────────────────────────────────────────
const IDB_NAME    = 'promemoriamio-sw';
const IDB_VERSION = 3;
const IDB_STORE   = 'notifiche';

function apriDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Migrazione: elimina store vecchi (v1: 'notifiche' senza status, v2: 'fired')
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
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();  // forza attivazione immediata senza aspettare chiusura tab
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() => ripristinaTimer())
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

// ── Timer in memoria ──────────────────────────────────────────────────────────
const timers = new Map();

function cancellaTimer(tag) {
  if (timers.has(tag)) {
    clearTimeout(timers.get(tag));
    timers.delete(tag);
  }
}

function mostraNotifica(n) {
  return self.registration.showNotification(n.title || 'PromemoriaMio', {
    body: n.body || 'Hai un impegno in programma',
    tag: n.tag,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200],
    renotify: true,
    requireInteraction: false,
    data: { url: './' }
  });
}

// ── Scheduling ────────────────────────────────────────────────────────────────
async function programmaNotifica({ tag, title, body, timestamp }) {
  cancellaTimer(tag);
  const delay = timestamp - Date.now();
  if (delay <= 0) return;

  console.log('[SW] programmaNotifica:', tag, 'tra', Math.round(delay / 60000) + ' min');
  await idbSalva({ tag, title, body, timestamp });

  const id = setTimeout(async () => {
    timers.delete(tag);
    await idbSegnaFired(tag);
    try {
      await mostraNotifica({ tag, title, body });
    } catch (err) {
      console.warn('[SW] showNotification error:', err);
    }
  }, delay);

  timers.set(tag, id);
}

// Safety net: al wake-up, ri-schedula solo ciò che è 'pending' e futuro
async function ripristinaTimer() {
  const pendenti = await idbLeggiPending();
  console.log('[SW] ripristinaTimer — pendenti:', pendenti.length);

  for (const n of pendenti) {
    const delay = n.timestamp - Date.now();
    const id = setTimeout(async () => {
      timers.delete(n.tag);
      await idbSegnaFired(n.tag);
      try {
        await mostraNotifica(n);
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
      // Reset completo: cancella timer + IDB, poi ri-schedula la lista fresca
      for (const [tag, id] of timers) {
        clearTimeout(id);
        timers.delete(tag);
      }
      idbSvuota().then(() => {
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
