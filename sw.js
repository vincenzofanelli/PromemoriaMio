// PromemoriaMio Service Worker v1.0
// Gestisce notifiche locali programmate

const CACHE_NAME = 'promemoriamio-v61';
const ASSETS = ['./index.html', './manifest.json'];

// ── IndexedDB helper ──────────────────────────────────────────────────────────
// Usata per persistere le notifiche schedulate: se lo SW viene terminato
// e poi risvegliato, le notifiche vengono ri-idratate da qui.
const IDB_NAME    = 'promemoriamio-sw';
const IDB_VERSION = 1;
const IDB_STORE   = 'notifiche';

function apriDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'tag' });
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

async function idbSvuota() {
  try {
    const db = await apriDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  } catch (err) {
    console.warn('[SW] idbSvuota error:', err);
  }
}

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // NON skipWaiting qui — vogliamo che il nuovo SW resti in "waiting"
  // così la pagina mostra il banner giallo e l'utente sceglie quando aggiornare
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() => ripristinaTimer())  // re-idrata notifiche dopo kill SW
  );
});

// ── Fetch (cache-first per assets, network-first per richieste esterne) ───────
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
  idbElimina(tag);  // rimuovi dalla persistenza
}

function programmaNotifica({ tag, title, body, timestamp }) {
  cancellaTimer(tag);
  const delay = timestamp - Date.now();
  if (delay <= 0) return;

  // Persisti prima di settare il timer: se lo SW viene killato
  // e risvegliato, ripristinaTimer() rilegerà da IDB
  idbSalva({ tag, title, body, timestamp });

  const id = setTimeout(async () => {
    timers.delete(tag);
    idbElimina(tag);  // notifica scattata: rimuovi dalla persistenza
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

// Richiamata al wake-up dello SW: rilegge IDB e re-schedula i timer pendenti
async function ripristinaTimer() {
  const pendenti = await idbLeggiTutte();
  pendenti.forEach(n => {
    if (n.timestamp > Date.now()) {
      // programmaNotifica salverebbe di nuovo su IDB — evitiamo lo scrivi ridondante
      // settando direttamente il timer (già in IDB)
      const delay = n.timestamp - Date.now();
      const id = setTimeout(async () => {
        timers.delete(n.tag);
        idbElimina(n.tag);
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
      // Timestamp già passato: pulizia
      idbElimina(n.tag);
    }
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const msg = e.data;
  if (!msg || !msg.tipo) return;

  switch (msg.tipo) {
    case 'SCHEDULE_NOTIFICHE': {
      // Cancella tutti i timer in memoria e svuota IDB, poi ri-schedula
      for (const [tag] of timers) cancellaTimer(tag);
      idbSvuota().then(() => {
        const lista = Array.isArray(msg.notifiche) ? msg.notifiche : [];
        lista.forEach(n => {
          if (n.tag && n.title && n.timestamp) programmaNotifica(n);
        });
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
