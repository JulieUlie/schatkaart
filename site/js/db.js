// IndexedDB storage in this browser only. Every collection item carries the id of the local
// profile it belongs to, so several people can keep their own collection on one device.
// "kv" holds the cached card index, each profile's pile and other small blobs.

const DB_NAME = 'schatkaart';
const VERSION = 1;
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('profile', 'profile', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is in use in another tab'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', (s) => { s.put(value, key); });
export const kvDel = (key) => run('kv', 'readwrite', (s) => { s.delete(key); });

/** All items of one profile, including deletion markers (needed for sync). */
export const itemsOf = (profile) => run('items', 'readonly', (s) => s.index('profile').getAll(profile));

export const itemsPut = (items) => run('items', 'readwrite', (s) => {
  for (const it of [].concat(items)) s.put(it);
});

export const itemsDeleteProfile = (profile) => run('items', 'readwrite', (s) => {
  const req = s.index('profile').openCursor(IDBKeyRange.only(profile));
  req.onsuccess = () => {
    const cur = req.result;
    if (cur) { cur.delete(); cur.continue(); }
  };
});
