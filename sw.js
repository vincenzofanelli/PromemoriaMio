// PromemoriaMio Service Worker v1.1
// Gestisce notifiche locali programmate (una per volta)

const CACHE_NAME = 'promemoriamio-v66';
const ASSETS = ['./index.html', './manifest.json'];

// ── IndexedDB helper ──────────────────────────────────────────────────────────
const IDB_NAME    = 'promemoriamio-sw';
const IDB_VERSION = 2;
const IDB_STORE   = 'notifiche';
const IDB_FIRED   = 'fired';

function apriDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'tag' });
      }
      if (!db.objectStoreNames.contains(IDB_FIRED)) {
        db.createObjectStore(IDB_FIRED, { keyPath: 'tag' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbSalva(notifica) {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(notifica);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbSalva error:', err);
  }
}

async function idbElimina(tag) {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).delete(tag);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbElimina error:', err);
  }
}

async function idbLeggiTutte() {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = e => resolve(e.target.result || []);
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbLeggiTutte error:', err);
    return [];
  }
}

// ── Store "fired": traccia i tag già scattati ────────────────────────────────
async function idbFiredAggiungi(tag) {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_FIRED, 'readwrite');
      tx.objectStore(IDB_FIRED).put({ tag, firedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbFiredAggiungi error:', err);
  }
}

async function idbFiredContiene(tag) {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_FIRED, 'readonly');
      const req = tx.objectStore(IDB_FIRED).get(tag);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbFiredContiene error:', err);
    return false;
  }
}

async function idbFiredElimina(tag) {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_FIRED, 'readwrite');
      const req = tx.objectStore(IDB_FIRED).delete(tag);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbFiredElimina error:', err);
  }
}

async function idbFiredPulisci() {
  // Rimuove voci fired > 7 giorni
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_FIRED, 'readwrite');
      const store = tx.objectStore(IDB_FIRED);
      const req = store.getAll();
      req.onsuccess = e => {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        (e.target.result || []).forEach(v => {
          if (v.firedAt < cutoff) store.delete(v.tag);
        });
        tx.oncomplete = () => resolve();
        tx.onerror   = err => reject(err);
      };
      req.onerror = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbFiredPulisci error:', err);
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
      .then(() => idbFiredPulisci())
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

// ── Notifiche programmate ─────────────────────────────────────────────────────
const timers = new Map();

function cancellaTimer(tag) {
  if (timers.has(tag)) {
    clearTimeout(timers.get(tag));
    timers.delete(tag);
  }
  idbElimina(tag);
  idbFiredElimina(tag);  // permette la ri-schedulazione se l'evento viene modificato
}

async function programmaNotifica({ tag, title, body, timestamp }) {
  // Guard: se è già scattata, non ri-schedulare
  if (await idbFiredContiene(tag)) {
    console.log('[SW] programmaNotifica: tag', tag, 'già fired — skip');
    return;
  }

  cancellaTimer(tag);
  const delay = timestamp - Date.now();
  console.log('[SW] programmaNotifica:', tag, 'delay ms:', delay, 'tra:', Math.round(delay / 60000) + ' min');
  if (delay <= 0) return;

  await idbSalva({ tag, title, body, timestamp });

  const id = setTimeout(async () => {
    timers.delete(tag);
    await idbElimina(tag);
    await idbFiredAggiungi(tag);
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
      console.warn('[SW] showNotification error:', err);
    }
  }, delay);

  timers.set(tag, id);
}

// Safety net: al wake-up dello SW, ri-schedula solo i timer pendenti
async function ripristinaTimer() {
  const pendenti = await idbLeggiTutte();
  console.log('[SW] ripristinaTimer — pendenti in IDB:', pendenti.length);

  for (const n of pendenti) {
    if (n.timestamp > Date.now() && !(await idbFiredContiene(n.tag))) {
      const delay = n.timestamp - Date.now();
      const id = setTimeout(async () => {
        timers.delete(n.tag);
        await idbElimina(n.tag);
        await idbFiredAggiungi(n.tag);
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
    } else {
      await idbElimina(n.tag);
    }
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || !msg.tipo) return;

  switch (msg.tipo) {
    case 'SCHEDULE_NOTIFICHE': {
      // Reset completo: cancella timer in memoria + entrambi gli store IDB, poi ri-schedula
      for (const [tag, id] of [...timers.entries()]) {
        clearTimeout(id);
        timers.delete(tag);
      }
      Promise.all([
        idbSvuota(),
        (async () => {
          const db = await apriDB();
          return new Promise((res, rej) => {
            const tx = db.transaction(IDB_FIRED, 'readwrite');
            tx.objectStore(IDB_FIRED).clear();
            tx.oncomplete = res;
            tx.onerror = e => rej(e.target.error);
          });
        })()
      ]).then(() => {
        const lista = Array.isArray(msg.notifiche) ? msg.notifiche : [];
        lista.forEach(n => {
          if (n.tag && n.title && n.timestamp) programmaNotifica(n);
        });
      }).catch(err => console.warn('[SW] SCHEDULE_NOTIFICHE error:', err));
      break;
    }
    case 'CANCEL_NOTIFICA': {
      if (msg.tag) {
        cancellaTimer(msg.tag);  // cancella timer, IDB notifiche e IDB fired
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