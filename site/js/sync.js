// Optional sync between someone's own devices. There are no accounts: a random sync code is the
// only key. The server stores the collection encrypted (AES-GCM) under a hash of that code, so it
// can neither read collections nor link them to a person.

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I confusion

export class SyncError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(20));
  return [...b].map((x) => ALPH[x & 31]).join('').match(/.{5}/g).join('-');
}

export function cleanCode(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 20 || [...s].some((ch) => !ALPH.includes(ch))) return null;
  return s.match(/.{5}/g).join('-');
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(code) {
  const c = code.replace(/-/g, '');
  const idBuf = await crypto.subtle.digest('SHA-256', enc.encode('schatkaart/id/' + c));
  const keyBuf = await crypto.subtle.digest('SHA-256', enc.encode('schatkaart/key/' + c));
  const key = await crypto.subtle.importKey('raw', keyBuf, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id: hex(idBuf), key };
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Newest version of every item wins; deletions are kept as markers so they spread too. */
export function mergeItems(a, b) {
  const m = new Map();
  for (const it of [...a, ...b]) {
    const cur = m.get(it.id);
    if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) m.set(it.id, it);
  }
  return [...m.values()];
}

const signature = (items) => items.map((i) => i.id + ':' + (i.updatedAt || 0)).sort().join('|');
const strip = (items) => items.map(({ profile, ...rest }) => rest);

export async function serverAvailable() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j.sync;
  } catch {
    return false;
  }
}

/** Pull, merge and push. Returns the merged list and whether local data changed. */
export async function syncItems(code, localItems) {
  if (!(await serverAvailable())) throw new SyncError('no-server', 'The sync server is not reachable.');
  const { id, key } = await derive(code);
  const local = strip(localItems);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`/api/sync/${id}`, { cache: 'no-store' });
    let remote = [];
    let rev = 0;
    if (res.ok) {
      const j = await res.json();
      rev = j.rev || 0;
      try {
        remote = (await unseal(key, j.box)).items || [];
      } catch {
        throw new SyncError('decrypt', 'Could not open the synced collection.');
      }
    } else if (res.status !== 404) {
      throw new SyncError('http', `Sync failed (${res.status}).`);
    }
    const merged = mergeItems(local, remote);
    if (signature(merged) !== signature(remote)) {
      const box = await seal(key, { v: 1, items: merged });
      const put = await fetch(`/api/sync/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ box, baseRev: rev }),
      });
      if (put.status === 409) continue; // another device pushed in between: merge again
      if (put.status === 413) throw new SyncError('too-large', 'Your collection is too large to sync.');
      if (!put.ok) throw new SyncError('http', `Sync failed (${put.status}).`);
    }
    return { items: merged, changedLocal: signature(merged) !== signature(local) };
  }
  throw new SyncError('busy', 'Another device is syncing at the same time. Try again in a moment.');
}

export async function deleteRemote(code) {
  const { id } = await derive(code);
  const res = await fetch(`/api/sync/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new SyncError('http', `Deleting failed (${res.status}).`);
}
