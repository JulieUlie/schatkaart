// Schatkaart app: views, scanning flow, "Is this your card?" confirmation, pile, collection,
// local profiles and optional sync. Everything personal lives in this browser (IndexedDB + localStorage).

import { $, $$, esc, uid, debounce, money, shortDate, norm, pool, download } from './util.js';
import { kvGet, kvSet, kvDel, itemsOf, itemsPut, itemsDeleteProfile } from './db.js';
import {
  LANGS, loadCatalog, getCard, imageUrl, search, variantsOf, VARIANT_LABEL, priceOf, bestPrice, pricesFor, marketLinks,
} from './catalog.js';
import { recognize, versionsOf, initOCR, onOcrProgress } from './recognize.js';
import { Camera, thumbDiff, canvasFromFile } from './camera.js';
import { EdgeTracker, warpCard } from './detect.js';
import { newCode, cleanCode, syncItems, deleteRemote, serverAvailable, mergeItems } from './sync.js';
import { hydrateMascots, setMood, mascotSVG } from './mascot.js';

// ---------- small persistent prefs ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('schatkaart:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('schatkaart:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const AVATARS = ['🦊', '🐱', '🐸', '🐼', '🐙', '🦄', '🐢', '🐧', '🐝', '🦖', '🐰', '🐻'];
const COLORS = ['#ffd23f', '#ff8fab', '#6ec6ff', '#7ae7c7', '#ff9f45', '#c4b1ff'];
const CONDITIONS = [['MT', 'Mint'], ['NM', 'Near mint'], ['EX', 'Excellent'], ['GD', 'Good'], ['LP', 'Light played'], ['PL', 'Played'], ['PO', 'Poor']];
const TARGET_LABEL = { pile: 'pile', collection: 'collection' };

const state = {
  settings: { source: 'cardmarket', lang: 'en', target: 'pile', ...LS.get('settings', {}) },
  profiles: LS.get('profiles', []),
  profileId: LS.get('profile', null),
  items: [],
  pile: [],
  cat: null,
  catError: null,
  view: 'scan',
  scanning: false,
  auto: false,
  pending: null,     // current "Is this your card?" question
  sheet: null,       // what the card sheet shows
  syncBusy: false,
  syncError: null,
  syncServer: undefined,
};

const video = $('#video');
const guide = $('#guide');
const vf = $('#viewfinder');
const cam = new Camera(video);
const tracker = new EdgeTracker();
const overlay = document.createElement('canvas');
overlay.className = 'overlay';
guide.before(overlay);

// ---------- helpers ----------
const profile = () => state.profiles.find((p) => p.id === state.profileId);
const live = () => state.items.filter((i) => !i.deleted);
const src = () => state.settings.source;
const displayCur = () => (src() === 'tcgplayer' ? 'USD' : 'EUR');
const otherSrc = () => (src() === 'cardmarket' ? 'tcgplayer' : 'cardmarket');
const SOURCE_LABEL = { cardmarket: 'Cardmarket', tcgplayer: 'TCGplayer' };
// The price of a stored card in the chosen market. If that market has none, the other market's price is
// shown in its own currency (v3 showed a TCGplayer dollar price with a euro sign and added it to the € total).
function priceEntry(e) {
  const own = e?.prices?.[src()]?.v;
  if (own != null) return { v: own, cur: displayCur(), own: true };
  const o = e?.prices?.[otherSrc()];
  return o?.v != null ? { v: o.v, cur: o.c || (otherSrc() === 'tcgplayer' ? 'USD' : 'EUR'), own: false } : null;
}
// Only prices in the chosen market's currency count towards totals.
const valueOf = (e) => e?.prices?.[src()]?.v ?? null;
const stickerOf = (e) => { const p = priceEntry(e); return priceSticker(p?.v ?? null, p?.cur || displayCur()); };
const saveSettings = () => LS.set('settings', state.settings);
const saveProfiles = () => { LS.set('profiles', state.profiles); LS.set('profile', state.profileId); };

function numLabel(card) {
  const id = card.localId ?? '';
  const off = card.set?.official ?? card.official;
  return /^\d+$/.test(id) && off ? `${id}/${String(off).padStart(String(id).length, '0')}` : id;
}

function tier(v) {
  if (v == null) return { key: 'none', label: 'No price yet' };
  if (v < 1) return { key: 'bulk', label: 'Bulk' };
  if (v < 5) return { key: 'nice', label: 'Nice!' };
  if (v < 20) return { key: 'ooh', label: 'Ooh!' };
  if (v < 100) return { key: 'treasure', label: 'Treasure!' };
  return { key: 'jackpot', label: 'JACKPOT!' };
}

function priceSticker(value, currency, extra = '') {
  const t = tier(value);
  return `<span class="sticker tier-${t.key} ${extra}">${value == null ? '?' : esc(money(value, currency))}</span>`;
}

const img = (image, q = 'low', cls = '') => (image
  ? `<img class="${cls}" src="${esc(imageUrl(image, q))}" alt="" loading="lazy" decoding="async">`
  : `<span class="ph ${cls}"></span>`);

function brandMood(mood, ms = 2200) {
  const el = $('#brandMascot');
  setMood(el, mood);
  clearTimeout(brandMood.t);
  brandMood.t = setTimeout(() => setMood(el, 'idle'), ms);
}

function toast(msg, { kind = '', action, onAction, ms = 3600 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn btn-small" type="button">${esc(action)}</button>` : ''}`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.querySelector('button')?.addEventListener('click', () => { close(); onAction?.(); });
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  setTimeout(close, ms);
}

function celebrate(key) {
  if (!['treasure', 'jackpot'].includes(key)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti');
  const colors = ['#ffd23f', '#ff8fab', '#6ec6ff', '#7ae7c7', '#ff9f45', '#c4b1ff'];
  const n = key === 'jackpot' ? 46 : 24;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    const ang = Math.random() * Math.PI * 2;
    const dist = 140 + Math.random() * 260;
    p.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(ang) * dist + 120}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.12}s`;
    if (i % 5 === 0) {
      p.className = 'star';
      p.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.3l7.1-.7z" fill="#ffd23f" stroke="#2b1d3f" stroke-width="2" stroke-linejoin="round"/></svg>';
    }
    box.append(p);
    setTimeout(() => p.remove(), 1600);
  }
}

// ---------- catalog ----------
let catP = null;
function ensureCatalog(force = false) {
  if (!force && state.cat && state.cat.lang === state.settings.lang) return Promise.resolve(state.cat);
  if (catP && !force) return catP;
  state.catError = null;
  renderDbStatus(true);
  catP = loadCatalog(state.settings.lang, { force, onUpdate: (c) => { state.cat = c; renderDbStatus(); } })
    .then((c) => { state.cat = c; renderDbStatus(); return c; })
    .catch((e) => { state.catError = e; renderDbStatus(); throw e; })
    .finally(() => { catP = null; });
  return catP;
}

function renderDbStatus(loading = false) {
  let text;
  if (loading && !state.cat) text = 'Downloading the card list (about 2–3 MB, only the first time)…';
  else if (state.catError && !state.cat) text = "Couldn't load the card list. Check your internet connection.";
  else if (state.cat) text = `${state.cat.cards.length.toLocaleString()} cards in ${LANGS[state.cat.lang] || state.cat.lang} · updated ${shortDate(new Date(state.cat.builtAt).toISOString())}`;
  else text = '';
  $('#dbStatus').textContent = text || '…';
  $('#dbHint').textContent = loading && !state.cat ? text : (state.catError && !state.cat ? text : '');
}

// ---------- items, pile ----------
async function saveItems(changed) {
  const list = [].concat(changed);
  for (const c of list) {
    const i = state.items.findIndex((x) => x.id === c.id);
    if (i >= 0) state.items[i] = c; else state.items.push(c);
  }
  await itemsPut(list);
  renderCollection();
  syncSoon();
}

async function savePile() {
  await kvSet('pile:' + state.profileId, state.pile);
  renderPile();
}

function entryFrom(brief, full, variant) {
  const now = Date.now();
  return {
    id: uid(),
    cardId: brief.id,
    lang: state.cat?.lang || state.settings.lang,
    name: full?.name || brief.name,
    setId: brief.setId,
    setName: brief.set?.name || full?.set?.name || '',
    setSymbol: null,
    localId: brief.localId,
    official: brief.set?.official || full?.set?.cardCount?.official || null,
    image: brief.image || full?.image || null,
    rarity: full?.rarity || null,
    variant,
    condition: 'NM',
    qty: 1,
    paid: null,
    paidCur: null,
    notes: '',
    prices: full ? pricesFor(full, variant) : { cardmarket: null, tcgplayer: null },
    pricedAt: full ? now : null,
    addedAt: now,
    updatedAt: now,
  };
}

async function addToCollection(brief, full, variant) {
  const e = entryFrom(brief, full, variant);
  const dup = live().find((i) => i.cardId === e.cardId && i.lang === e.lang && i.variant === e.variant && i.condition === e.condition);
  if (dup) {
    await saveItems({ ...dup, qty: dup.qty + 1, prices: full ? e.prices : dup.prices, pricedAt: full ? e.pricedAt : dup.pricedAt, updatedAt: Date.now() });
    return { target: 'collection', id: dup.id, inc: 1 };
  }
  e.profile = state.profileId;
  await saveItems(e);
  return { target: 'collection', id: e.id, created: true };
}

async function addToPile(brief, full, variant) {
  const e = entryFrom(brief, full, variant);
  state.pile.unshift(e);
  await savePile();
  return { target: 'pile', id: e.id, created: true };
}

async function addTo(target, brief, full, variant) {
  return target === 'collection' ? addToCollection(brief, full, variant) : addToPile(brief, full, variant);
}

async function undo(ref) {
  if (!ref) return;
  if (ref.target === 'pile') {
    state.pile = state.pile.filter((e) => e.id !== ref.id);
    await savePile();
    return;
  }
  const it = state.items.find((i) => i.id === ref.id);
  if (!it) return;
  if (ref.created) await saveItems({ id: it.id, profile: it.profile, deleted: true, updatedAt: Date.now() });
  else await saveItems({ ...it, qty: Math.max(1, it.qty - ref.inc), updatedAt: Date.now() });
}

// ---------- camera + live edge outline ----------
let loopId = null;
let lastDetect = 0;
let lastScanThumb = null;
let lostSince = 0;

async function startCamera() {
  $('#camError').hidden = true;
  try {
    await cam.start();
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or pick a photo instead.'
      : e.name === 'NotFoundError' ? 'No camera found on this device. You can pick a photo instead.'
        : (e.message || 'The camera could not start.');
    $('#camError').textContent = msg;
    $('#camError').hidden = false;
    LS.set('camOn', false);
    return;
  }
  LS.set('camOn', true);
  vf.classList.add('cam-on');
  $('#vfIdle').hidden = true;
  $('#vfHint').hidden = false;
  $('#shutter').disabled = false;
  $('#torchBtn').hidden = !cam.torchSupported;
  tracker.reset();
  sizeOverlay();
  startLoop();
  ensureCatalog().catch(() => {});
  initOCR().catch(() => toast("Couldn't load the text reader. Check your connection.", { kind: 'err' }));
}

function stopCamera() {
  cam.stop();
  vf.classList.remove('cam-on', 'tracking');
  $('#vfIdle').hidden = false;
  $('#vfHint').hidden = true;
  $('#shutter').disabled = true;
  $('#torchBtn').hidden = true;
  if (loopId) cancelAnimationFrame(loopId);
  loopId = null;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
}

function sizeOverlay() {
  const r = vf.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  overlay.width = Math.round(r.width * dpr);
  overlay.height = Math.round(r.height * dpr);
}

function startLoop() {
  if (loopId) return;
  const tick = (now) => {
    if (!cam.on || state.view !== 'scan' || document.hidden) { loopId = null; return; }
    loopId = requestAnimationFrame(tick);
    if (now - lastDetect < 66) { drawOverlay(tracker.state(now), now); return; }
    lastDetect = now;
    const st = tracker.update(video, cam.guideRect(guide), now);
    drawOverlay(st, now);
    updateHint(st, now);
    maybeAutoScan(st, now);
  };
  loopId = requestAnimationFrame(tick);
}

const LOCK_MS = 450;

function toView(pts) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W = overlay.width;
  const H = overlay.height;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2;
  const oy = (H - vh * s) / 2;
  return pts.map(([x, y]) => [ox + x * s, oy + y * s]);
}

function drawOverlay(st, now) {
  const g = overlay.getContext('2d');
  g.clearRect(0, 0, overlay.width, overlay.height);
  vf.classList.toggle('tracking', !!st.quad);
  if (!st.quad || !video.videoWidth) return;
  const q = toView(st.quad);
  const dpr = overlay.width / vf.clientWidth || 1;
  const locked = st.stableMs > LOCK_MS;
  const color = state.scanning ? '#ff8fab' : locked ? '#3ddc97' : '#d8d2e2'; // grey while searching, green when locked
  const pulse = locked ? 1 + 0.18 * Math.sin(now / 140) : 1;

  g.lineJoin = 'round';
  g.lineCap = 'round';
  const path = () => { g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
  // soft fill
  path();
  g.fillStyle = locked ? 'rgba(61,220,151,.12)' : 'rgba(216,210,226,.10)';
  g.fill();
  // ink outline under a glowing colour line: the cartoon look
  path();
  g.strokeStyle = '#2b1d3f';
  g.lineWidth = 9 * dpr;
  g.stroke();
  g.save();
  g.shadowColor = color;
  g.shadowBlur = 18 * dpr * pulse;
  path();
  g.strokeStyle = color;
  g.lineWidth = 4.5 * dpr * pulse;
  g.stroke();
  g.restore();
  // corner blobs
  for (const [x, y] of q) {
    g.beginPath();
    g.arc(x, y, 8 * dpr * pulse, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 3 * dpr;
    g.strokeStyle = '#2b1d3f';
    g.stroke();
  }
  // a little sparkle travelling around the edge while locked
  if (locked && !state.scanning) {
    const t = (now / 1600) % 1;
    const seg = Math.floor(t * 4);
    const f = t * 4 - seg;
    const a = q[seg];
    const b = q[(seg + 1) % 4];
    const x = a[0] + (b[0] - a[0]) * f;
    const y = a[1] + (b[1] - a[1]) * f;
    star(g, x, y, 11 * dpr);
  }
}

function star(g, x, y, r) {
  g.save();
  g.translate(x, y);
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? r * 0.38 : r;
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = '#fff6c2';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = '#2b1d3f';
  g.stroke();
  g.restore();
}

let ocrHint = '';
function updateHint(st) {
  const el = $('#vfHint');
  el.classList.remove('locked');
  if (state.scanning) { el.hidden = true; return; }
  el.hidden = false;
  if (ocrHint) { el.textContent = ocrHint; return; }
  if (!st.quad) el.textContent = 'Fit one card inside the frame';
  else if (st.stableMs < LOCK_MS) el.textContent = 'Found it! Hold still…';
  else { el.textContent = state.auto ? 'Locked on! Scanning…' : 'Locked on! Tap the sparkle ✦'; el.classList.add('locked'); }
}

function maybeAutoScan(st, now) {
  if (!st.quad) {
    if (!lostSince) lostSince = now;
    if (now - lostSince > 900) lastScanThumb = null; // card taken away: allow scanning it again
    return;
  }
  lostSince = 0;
  if (!state.auto || state.scanning || $('#sheet').open || $('#searchDlg').open) return;
  if (st.stableMs < 700) return;
  const t = cam.thumb(guide);
  if (lastScanThumb && thumbDiff(t, lastScanThumb) < 14) return; // same card as last time
  lastScanThumb = t;
  scanNow();
}

function captureCard() {
  const st = tracker.state();
  if (st.quad) {
    const w = warpCard(video, st.quad, 760);
    if (w) return w;
  }
  return cam.capture(guide, 900);
}

async function scanNow() {
  if (state.scanning || !cam.on) return;
  const photo = captureCard();
  if (!photo) return;
  lastScanThumb = cam.thumb(guide);
  navigator.vibrate?.(12);
  await runRecognition(photo);
}

async function scanFile(file) {
  if (!file) return;
  try {
    // Take the whole photo, find the card in it and straighten it; fall back to the centre crop.
    const full = await canvasFromFile(file, 1600, false);
    full.videoWidth = full.width; full.videoHeight = full.height;
    const gh = Math.min(full.height * 0.9, full.width * 0.9 * 88 / 63);
    const gw = gh * 63 / 88;
    const roi = { sx: (full.width - gw) / 2, sy: (full.height - gh) / 2, sw: gw, sh: gh };
    const tr = new EdgeTracker();
    let st;
    for (let i = 0; i < 3; i++) st = tr.update(full, roi, performance.now() + i * 70);
    const photo = (st.quad && warpCard(full, st.quad, 760)) || await canvasFromFile(file);
    await runRecognition(photo);
  } catch {
    toast("That photo couldn't be opened.", { kind: 'err' });
  }
}

async function runRecognition(photo) {
  state.scanning = true;
  $('#shutter').classList.add('busy');
  $('#vfBusy').hidden = false;
  $('#vfBusyText').textContent = 'Let me see…';
  $('#mini').hidden = true;
  brandMood('think', 60000);
  try {
    const cat = await ensureCatalog();
    const res = await recognize(cat, photo, { onStage: (t) => { $('#vfBusyText').textContent = t; } });
    if (!res.candidates.length) {
      state.pending = null;
      showMiniNone();
      brandMood('sad');
      return;
    }
    await ask({ photo, candidates: res.candidates, confident: res.confident, chosen: res.candidates[0].card, fromScan: true });
  } catch (e) {
    console.error(e);
    toast(state.cat ? 'Something went wrong while reading the card.' : "The card list isn't loaded yet. Check your connection.", { kind: 'err' });
    brandMood('sad');
  } finally {
    state.scanning = false;
    $('#shutter').classList.remove('busy');
    $('#vfBusy').hidden = true;
  }
}

// ---------- "Is this your card?" ----------
async function ask({ photo = null, candidates = [], confident = false, chosen, fromScan = false }) {
  const P = {
    photo, candidates, confident, chosen, fromScan,
    full: null, variant: null, added: null, versions: null, token: uid(),
  };
  state.pending = P;
  await loadChosen(P);
  if (state.pending !== P) return;
  brandMood(confident ? 'happy' : 'think');
  // Auto mode trusts confident matches; everything else waits for "Yes, that's it".
  if (state.auto && confident && fromScan && state.settings.target !== 'none') await confirm(P, state.settings.target, { quiet: true });
  showMiniAsk();
  if (!fromScan || !confident) openConfirmSheet();
  computeVersions(P);
}

async function loadChosen(P) {
  P.full = null;
  try { P.full = await getCard(P.chosen.id, state.cat.lang); } catch { /* offline: show without price */ }
  P.variant = variantsOf(P.full)[0];
}

async function computeVersions(P) {
  P.versions = null;
  const list = await versionsOf(state.cat, P.chosen, P.photo).catch(() => [{ card: P.chosen }]);
  if (state.pending !== P) return;
  P.versions = list;
  if (state.sheet?.mode === 'confirm') renderSheet();
}

async function confirm(P, target, { quiet = false } = {}) {
  if (P.added) return;
  P.added = await addTo(target, P.chosen, P.full, P.variant);
  const v = bestPrice(P.full, P.variant, src())?.value ?? null;
  const t = tier(v);
  brandMood(t.key === 'treasure' || t.key === 'jackpot' ? 'wow' : 'happy', 2600);
  celebrate(t.key);
  navigator.vibrate?.(t.key === 'jackpot' ? [30, 40, 30, 40, 60] : 25);
  if (!quiet) {
    const ref = P.added;
    toast(`${P.chosen.name} added to your ${TARGET_LABEL[target]}`, {
      kind: 'ok', action: 'Undo', onAction: async () => { await undo(ref); if (P.added === ref) P.added = null; refreshPendingViews(); },
    });
  }
}

async function choose(P, card) {
  if (card.id === P.chosen.id) return;
  const prevTarget = P.added?.target;
  if (P.added) { await undo(P.added); P.added = null; }
  P.chosen = card;
  renderSheet();
  await loadChosen(P);
  if (state.pending !== P) return;
  if (prevTarget) await confirm(P, prevTarget, { quiet: true });
  refreshPendingViews();
  // Re-rank versions if the user picked a card with a different name.
  if (!P.versions?.some((e) => e.card.id === card.id)) computeVersions(P);
}

async function setPendingVariant(P, v) {
  P.variant = v;
  if (P.added) {
    const t = P.added.target;
    await undo(P.added);
    P.added = null;
    await confirm(P, t, { quiet: true });
  }
  refreshPendingViews();
}

function refreshPendingViews() {
  if (state.pending) showMiniAsk();
  if (state.sheet?.mode === 'confirm') renderSheet();
}

function showMiniNone() {
  const el = $('#mini');
  el.hidden = false;
  el.innerHTML = `
    <div class="mini-row">
      <span style="width:52px;flex:none">${mascotSVG('sad')}</span>
      <div class="mini-text"><b>Hmm, I don't recognise that one.</b><small>Try more light, a straighter angle, or search by name.</small></div>
    </div>
    <div class="mini-actions">
      <button class="btn btn-small" type="button" data-act="search"><svg><use href="#i-search"/></svg>Search</button>
      <button class="x-btn" type="button" data-act="dismiss" aria-label="Close"><svg><use href="#i-x"/></svg></button>
    </div>`;
}

function showMiniAsk() {
  const P = state.pending;
  const el = $('#mini');
  if (!P) { el.hidden = true; return; }
  const c = P.chosen;
  const p = bestPrice(P.full, P.variant, src());
  const where = P.added ? TARGET_LABEL[P.added.target] : null;
  el.hidden = false;
  el.innerHTML = `
    <p class="mini-q">${P.added ? `<svg><use href="#i-check"/></svg>Added to your ${where}` : P.confident ? 'Is this your card?' : 'Hmm… is it this one?'}</p>
    <div class="mini-row">
      ${img(c.image, 'low', 'mini-thumb')}
      <div class="mini-text"><b>${esc(c.name)}</b><small>${esc(c.set?.name || '')} · ${esc(numLabel(c))}${P.variant && P.variant !== 'normal' ? ' · ' + esc(VARIANT_LABEL[P.variant]) : ''}</small></div>
      ${priceSticker(p?.value ?? null, p?.currency || displayCur())}
    </div>
    <div class="mini-actions">
      ${P.added
    ? '<button class="btn btn-small" type="button" data-act="undo">Undo</button><button class="btn btn-small" type="button" data-act="versions"><svg><use href="#i-layers"/></svg>Wrong version?</button>'
    : `<button class="btn btn-mint" type="button" data-act="confirm"><svg><use href="#i-check"/></svg>Yes!</button><button class="btn" type="button" data-act="versions"><svg><use href="#i-layers"/></svg>Other versions</button>`}
      <button class="x-btn" type="button" data-act="dismiss" aria-label="Close"><svg><use href="#i-x"/></svg></button>
    </div>`;
}

$('#mini').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const P = state.pending;
  if (!act) { if (P) openConfirmSheet(); return; }
  if (act === 'dismiss') { $('#mini').hidden = true; state.pending = null; return; }
  if (act === 'search') { openSearch(); return; }
  if (!P) return;
  if (act === 'confirm') {
    if (state.settings.target === 'none') { openConfirmSheet(); return; }
    await confirm(P, state.settings.target);
    showMiniAsk();
  } else if (act === 'undo') {
    await undo(P.added); P.added = null; showMiniAsk();
  } else if (act === 'versions') openConfirmSheet();
});

// ---------- card sheet ----------
function openConfirmSheet() {
  if (!state.pending) return;
  state.sheet = { mode: 'confirm' };
  renderSheet();
  showDialog($('#sheet'));
}

function openItemSheet(id) {
  state.sheet = { mode: 'item', id, full: null };
  renderSheet();
  showDialog($('#sheet'));
  const it = state.items.find((i) => i.id === id);
  if (it) {
    getCard(it.cardId, it.lang).then((full) => {
      if (state.sheet?.id !== id) return;
      state.sheet.full = full;
      renderSheet();
    }).catch(() => {});
  }
}

function openPileSheet(id) {
  state.sheet = { mode: 'pile', id, full: null };
  renderSheet();
  showDialog($('#sheet'));
  const e = state.pile.find((x) => x.id === id);
  if (e) getCard(e.cardId, e.lang).then((full) => { if (state.sheet?.id === id) { state.sheet.full = full; renderSheet(); } }).catch(() => {});
}

function detailHTML({ name, image, setName, setSymbol, num, rarity, full, variant, cardId, brief }) {
  const p = bestPrice(full, variant, src());
  const other = priceOf(full, variant, src() === 'cardmarket' ? 'tcgplayer' : 'cardmarket');
  const t = tier(p?.value ?? null);
  const vars = full ? variantsOf(full) : [variant || 'normal'];
  const links = marketLinks(full, brief || { name, localId: num, set: { name: setName } });
  return `
  <div class="detail">
    <div class="card-frame">${image ? `<img src="${esc(imageUrl(image, 'high'))}" alt="${esc(name)}">` : ''}</div>
    <div class="detail-info">
      <h2>${esc(name)}</h2>
      <div class="setline">
        ${setSymbol ? `<img class="sym" src="${esc(setSymbol)}.png" alt="" onerror="this.remove()">` : ''}
        <span>${esc(setName || '')}</span><span class="numtag">${esc(num)}</span>
        ${rarity || full?.rarity ? `<span>· ${esc(rarity || full.rarity)}</span>` : ''}
      </div>
      <div class="price-box">
        ${full ? priceSticker(p?.value ?? null, p?.currency || displayCur(), 'price-big') : '<span class="sticker tier-none price-big">…</span>'}
        <span class="price-tier">${full ? (p ? esc(t.label) : `No price known yet · <a href="${esc(links.cardmarket)}" target="_blank" rel="noopener">Check price on Cardmarket</a>`) : 'Fetching price…'}</span>
      </div>
      ${p ? `<div class="price-rows">${p.rows.filter((r) => r[1] != null).map(([k, v]) => `<span>${esc(k)} <b>${esc(money(v, p.currency))}</b></span>`).join('')}
        ${other ? `<span>${src() === 'cardmarket' ? 'TCGplayer' : 'Cardmarket'} <b>${esc(money(other.value, other.currency))}</b></span>` : ''}</div>
        <p class="tiny muted">${p.source === 'cardmarket' ? 'Cardmarket' : 'TCGplayer'} · updated ${esc(shortDate(p.updated))}${p.exact ? '' : ' · no separate price for this variant'}</p>` : ''}
      ${vars.length > 1 ? `<div class="chips" role="group" aria-label="Variant">${vars.map((v) => `<button class="chip" type="button" data-variant="${v}" aria-pressed="${v === variant}">${esc(VARIANT_LABEL[v])}</button>`).join('')}</div>` : ''}
      <div class="links">
        <a href="${esc(links.cardmarket)}" target="_blank" rel="noopener">Cardmarket <svg><use href="#i-external"/></svg></a>
        <a href="${esc(links.tcgplayer)}" target="_blank" rel="noopener">TCGplayer <svg><use href="#i-external"/></svg></a>
      </div>
      <!--${esc(cardId || '')}-->
    </div>
  </div>`;
}

// What kind of print this is, from the rarity and the number (secret rares sit above the set size).
function printKind(card) {
  const r = (card.rarity || '').toLowerCase();
  const n = parseInt(card.localId, 10);
  const off = card.set?.official;
  if (/special illustration/.test(r)) return 'Special illustration';
  if (/illustration/.test(r)) return 'Illustration rare';
  if (/hyper|rainbow|gold/.test(r)) return 'Gold / rainbow';
  if (/promo/.test(r) || /promo/i.test(card.set?.name || '')) return 'Promo';
  if (/full art|ultra/.test(r)) return 'Full art';
  if (Number.isFinite(n) && off && n > off) return 'Secret rare';
  if (/^[A-Z]+\d/.test(card.localId || '')) return 'Subset';
  return null;
}

function versionCard(card, { current = false, sameArt = false } = {}) {
  const code = card.set?.code;
  const year = card.set?.released?.slice(0, 4);
  const kind = printKind(card);
  return `<button class="vcard ${current ? 'current' : ''}" type="button" data-pick="${esc(card.id)}" aria-pressed="${current}">
    ${sameArt ? '<span class="badge">Same art</span>' : ''}
    ${img(card.image, 'low')}
    <span class="vset">${card.set?.symbol ? `<img src="${esc(card.set.symbol)}.png" alt="" loading="lazy" onerror="this.remove()">` : ''}<span>${esc(card.set?.name || '')}</span></span>
    <span class="vnum">${code ? `<span class="numtag">${esc(code)}</span>` : ''}<span class="numtag">${esc(numLabel(card))}</span>${year ? `<small class="muted"> ${esc(year)}</small>` : ''}</span>
    ${card.rarity || kind ? `<span class="vkind">${[kind, card.rarity].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).map(esc).join(' · ')}</span>` : ''}
    <span class="vprice" data-price-for="${esc(card.id)}">…</span>
  </button>`;
}

// Versions grouped per artwork: "Art 1" holds every set/number that reuses the same picture.
function versionGroups(versions, currentId) {
  const groups = new Map();
  for (const e of versions) {
    const k = e.art ?? 'none';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const list = [...groups.entries()].sort((a, b) => (b[1].some((e) => e.card.id === currentId) - a[1].some((e) => e.card.id === currentId)) || (a[0] === 'none') - (b[0] === 'none'));
  let n = 0;
  return list.map(([k, items]) => {
    const title = k === 'none' ? 'No picture to compare' : `Art ${++n}`;
    const mine = items.some((e) => e.card.id === currentId);
    return `<div class="artgroup"><h4>${esc(title)}${mine ? ' · your scan' : ''} <small class="muted">${items.length} print${items.length === 1 ? '' : 's'}</small></h4>
      <div class="vgrid">${items.map((e) => versionCard(e.card, { current: e.card.id === currentId, sameArt: !!e.sameArt })).join('')}</div></div>`;
  }).join('');
}

function renderSheet() {
  const body = $('#sheetBody');
  const S = state.sheet;
  if (!S) return;
  if (S.mode === 'confirm') {
    const P = state.pending;
    if (!P) { closeDialog($('#sheet')); return; }
    const c = P.chosen;
    const target = state.settings.target;
    const otherTarget = target === 'collection' ? 'pile' : 'collection';
    const versions = P.versions;
    const others = P.candidates.filter((e) => e.card.n !== c.n).slice(0, 8);
    body.innerHTML = `
      <div class="ask">
        <span>${mascotSVG(P.added ? 'happy' : 'think')}</span>
        <div><h2>${P.added ? 'Got it!' : 'Is this your card?'}</h2>
        <p>${P.added ? `It's on your ${TARGET_LABEL[P.added.target]}. Picked the wrong print? Tap the right one below.` : 'Compare the set symbol and the number at the bottom of your card. Prices differ per print!'}</p></div>
      </div>
      ${detailHTML({ name: P.full?.name || c.name, image: c.image, setName: c.set?.name, setSymbol: c.set?.symbol, num: numLabel(c), full: P.full, variant: P.variant, brief: c })}
      <div class="actions">
        ${P.added
    ? `<button class="btn" type="button" data-act="undo">Undo</button><button class="btn btn-mint" type="button" data-act="close"><svg><use href="#i-check"/></svg>Done</button>`
    : target === 'none'
      ? `<button class="btn btn-mint btn-big" type="button" data-act="add" data-target="pile"><svg><use href="#i-check"/></svg>Yes! Add to pile</button>
         <button class="btn" type="button" data-act="add" data-target="collection">Add to collection</button>`
      : `<button class="btn btn-mint btn-big" type="button" data-act="add" data-target="${target}"><svg><use href="#i-check"/></svg>Yes! Add to ${TARGET_LABEL[target]}</button>
         <button class="btn" type="button" data-act="add" data-target="${otherTarget}">Add to ${TARGET_LABEL[otherTarget]} instead</button>`}
      </div>
      <div class="versions">
        <h3><svg><use href="#i-layers"/></svg>All versions of ${esc(c.name)}</h3>
        <p>Same name, different print: grouped per artwork, each with its set code, number and type. Prices differ per print!</p>
        ${versions
    ? versionGroups(versions, c.id)
    : `<div class="vgrid"><p class="muted">${mascotSVG('think').replace('class="schatje"', 'class="schatje" style="width:44px;display:inline-block;vertical-align:middle"')} Looking up every print…</p></div>`}
        ${others.length ? `<h3>Or maybe one of these?</h3><div class="vgrid">${others.map((e) => versionCard(e.card)).join('')}</div>` : ''}
        <p style="margin-top:18px"><button class="btn btn-small btn-ghost" type="button" data-act="search"><svg><use href="#i-search"/></svg>None of these? Search by name</button></p>
      </div>`;
    fillVersionPrices(body);
    return;
  }

  if (S.mode === 'item') {
    const it = state.items.find((i) => i.id === S.id && !i.deleted);
    if (!it) { closeDialog($('#sheet')); return; }
    const full = S.full;
    body.innerHTML = `
      ${detailHTML({ name: it.name, image: it.image, setName: it.setName, setSymbol: null, num: numLabel(it), rarity: it.rarity, full: full || pseudoFull(it), variant: it.variant, brief: it })}
      <div class="form-grid">
        <div class="field labelled"><span>How many</span>
          <div class="stepper"><button type="button" data-qty="-1" aria-label="One less"><svg><use href="#i-minus"/></svg></button><output>${it.qty}</output><button type="button" data-qty="1" aria-label="One more"><svg><use href="#i-plus"/></svg></button></div>
        </div>
        <label class="field labelled"><span>Condition</span>
          <select data-field="condition">${CONDITIONS.map(([k, l]) => `<option value="${k}" ${k === it.condition ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="field labelled"><span>Paid in total (${displayCur() === 'USD' ? '$' : '€'})</span>
          <input data-field="paid" type="number" inputmode="decimal" min="0" step="0.01" value="${it.paid ?? ''}" placeholder="optional">
        </label>
      </div>
      <label class="field labelled"><span>Notes</span><input data-field="notes" type="text" value="${esc(it.notes || '')}" placeholder="e.g. found at the Sunday market"></label>
      <p class="tiny muted">Added ${esc(shortDate(new Date(it.addedAt).toISOString()))}</p>
      <div class="actions">
        <button class="btn btn-red btn-small" type="button" data-act="delete"><svg><use href="#i-trash"/></svg>Remove from collection</button>
        <button class="btn btn-mint" type="button" data-act="close"><svg><use href="#i-check"/></svg>Done</button>
      </div>`;
    return;
  }

  if (S.mode === 'pile') {
    const e = state.pile.find((x) => x.id === S.id);
    if (!e) { closeDialog($('#sheet')); return; }
    body.innerHTML = `
      ${detailHTML({ name: e.name, image: e.image, setName: e.setName, setSymbol: null, num: numLabel(e), rarity: e.rarity, full: S.full || pseudoFull(e), variant: e.variant, brief: e })}
      <div class="actions">
        <button class="btn btn-small" type="button" data-act="pile-remove"><svg><use href="#i-trash"/></svg>Take off the pile</button>
        <button class="btn btn-mint" type="button" data-act="pile-keep"><svg><use href="#i-chest"/></svg>Move to collection</button>
      </div>`;
  }
}

// When details can't be fetched (offline), show the stored price snapshot.
function pseudoFull(e) {
  const cm = e.prices?.cardmarket;
  const tp = e.prices?.tcgplayer;
  return {
    name: e.name,
    rarity: e.rarity,
    variants: { [e.variant]: true },
    pricing: {
      cardmarket: cm ? { unit: cm.c, trend: e.variant === 'reverse' ? null : cm.v, 'trend-holo': e.variant === 'reverse' ? cm.v : null, updated: e.pricedAt && new Date(e.pricedAt).toISOString() } : null,
      tcgplayer: tp ? { unit: tp.c, updated: e.pricedAt && new Date(e.pricedAt).toISOString(), [e.variant === 'reverse' ? 'reverse-holofoil' : e.variant === 'holo' ? 'holofoil' : 'normal']: { marketPrice: tp.v } } : null,
    },
  };
}

async function fillVersionPrices(root) {
  const els = $$('[data-price-for]', root);
  await pool(els, 4, async (el) => {
    try {
      const full = await getCard(el.dataset.priceFor, state.cat.lang);
      const p = bestPrice(full, variantsOf(full)[0], src());
      el.textContent = p ? money(p.value, p.currency) : 'no price';
    } catch { el.textContent = ''; }
  });
}

$('#sheetBody').addEventListener('click', async (e) => {
  const S = state.sheet;
  if (!S) return;
  const pick = e.target.closest('[data-pick]');
  const chip = e.target.closest('[data-variant]');
  const act = e.target.closest('[data-act]')?.dataset.act;
  const qty = e.target.closest('[data-qty]');

  if (S.mode === 'confirm') {
    const P = state.pending;
    if (!P) return;
    if (pick) {
      const card = state.cat.byId.get(pick.dataset.pick);
      if (card) await choose(P, card);
    } else if (chip) {
      await setPendingVariant(P, chip.dataset.variant);
    } else if (act === 'add') {
      await confirm(P, e.target.closest('[data-act]').dataset.target);
      refreshPendingViews();
    } else if (act === 'undo') {
      await undo(P.added); P.added = null; refreshPendingViews();
    } else if (act === 'close') closeDialog($('#sheet'));
    else if (act === 'search') { closeDialog($('#sheet')); openSearch(P.chosen.name); }
    return;
  }

  if (S.mode === 'item') {
    const it = state.items.find((i) => i.id === S.id);
    if (!it) return;
    if (qty) {
      const n = Math.max(1, it.qty + Number(qty.dataset.qty));
      if (n !== it.qty) { await saveItems({ ...it, qty: n, updatedAt: Date.now() }); renderSheet(); }
    } else if (chip && S.full) {
      const v = chip.dataset.variant;
      await saveItems({ ...it, variant: v, prices: pricesFor(S.full, v), pricedAt: Date.now(), updatedAt: Date.now() });
      renderSheet();
    } else if (act === 'delete') {
      const copy = { ...it };
      await saveItems({ id: it.id, profile: it.profile, deleted: true, updatedAt: Date.now() });
      closeDialog($('#sheet'));
      toast(`${it.name} removed`, { action: 'Undo', onAction: () => saveItems({ ...copy, updatedAt: Date.now() }) });
    } else if (act === 'close') closeDialog($('#sheet'));
    return;
  }

  if (S.mode === 'pile') {
    const entry = state.pile.find((x) => x.id === S.id);
    if (!entry) return;
    if (chip && S.full) {
      const v = chip.dataset.variant;
      Object.assign(entry, { variant: v, prices: pricesFor(S.full, v), pricedAt: Date.now() });
      await savePile();
      renderSheet();
    } else if (act === 'pile-remove') {
      state.pile = state.pile.filter((x) => x.id !== entry.id);
      await savePile();
      closeDialog($('#sheet'));
    } else if (act === 'pile-keep') {
      await movePileToCollection([entry]);
      closeDialog($('#sheet'));
    }
  }
});

$('#sheetBody').addEventListener('change', async (e) => {
  const S = state.sheet;
  const f = e.target.dataset.field;
  if (S?.mode !== 'item' || !f) return;
  const it = state.items.find((i) => i.id === S.id);
  if (!it) return;
  const patch = { updatedAt: Date.now() };
  if (f === 'paid') {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    patch.paid = Number.isFinite(v) && v >= 0 ? v : null;
    patch.paidCur = patch.paid == null ? null : displayCur();
  } else patch[f] = e.target.value;
  await saveItems({ ...it, ...patch });
});

// ---------- dialogs ----------
function showDialog(d) {
  if (!d.open) d.showModal();
}
function closeDialog(d) {
  if (d.open) d.close();
}
for (const d of $$('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) closeDialog(d);
  });
  d.addEventListener('close', () => {
    if (d.id === 'sheet') state.sheet = null;
    if (d.id === 'profileDlg') renderProfiles();
  });
}

// ---------- search ----------
function openSearch(prefill = '') {
  const d = $('#searchDlg');
  const input = $('#searchInput');
  input.value = prefill;
  renderSearch();
  showDialog(d);
  setTimeout(() => input.focus(), 50);
  ensureCatalog().then(renderSearch).catch(() => {});
}

const renderSearch = debounce(() => {
  const q = $('#searchInput').value;
  const ul = $('#searchResults');
  if (!state.cat) { ul.innerHTML = '<li class="muted">Loading the card list…</li>'; return; }
  const res = q.trim() ? search(state.cat, q, 60) : [];
  $('#searchHint').hidden = !!res.length;
  ul.innerHTML = res.map((c) => `<li><button type="button" data-id="${esc(c.id)}">
    ${img(c.image)}<span class="txt"><b>${esc(c.name)}</b><small>${esc(c.set.name)} · ${esc(numLabel(c))}</small></span></button></li>`).join('')
    || (q.trim() ? '<li class="muted">No cards found. Check the spelling, or try just the name.</li>' : '');
}, 120);

$('#searchInput').addEventListener('input', renderSearch);
$('#searchResults').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!id) return;
  const card = state.cat.byId.get(id);
  closeDialog($('#searchDlg'));
  if (state.view !== 'scan') location.hash = '#scan';
  await ask({ candidates: [{ card }], confident: true, chosen: card, fromScan: false });
});

// ---------- pile ----------
function renderPile() {
  const ul = $('#pileList');
  const cur = displayCur();
  let total = 0;
  let unknown = 0;
  let otherOnly = 0;
  for (const e of state.pile) { const p = priceEntry(e); if (!p) unknown++; else if (!p.own) otherOnly++; else total += p.v; }
  $('#pileTotal').textContent = money(total, cur);
  $('#pileTotal').className = `sticker pile-total tier-${tier(state.pile.length ? total : null).key}`;
  $('#pileEmpty').hidden = state.pile.length > 0;
  $('#pileActions').hidden = !state.pile.length;
  ul.innerHTML = state.pile.map((e) => `<li>
    <button class="open" type="button" data-open="${esc(e.id)}">${img(e.image)}
      <span class="txt"><span class="name">${esc(e.name)}</span><span class="meta">${[e.setName, numLabel(e), e.variant !== 'normal' && VARIANT_LABEL[e.variant]].filter(Boolean).map(esc).join(' · ')}</span></span>
      ${stickerOf(e)}</button>
    <button class="x-btn" type="button" data-remove="${esc(e.id)}" aria-label="Take ${esc(e.name)} off the pile"><svg><use href="#i-x"/></svg></button>
  </li>`).join('');
  const notes = [unknown && `${unknown} without price`, otherOnly && `${otherOnly} only on ${SOURCE_LABEL[otherSrc()]}`].filter(Boolean);
  $('#pileTitle').textContent = state.pile.length ? `Pile · ${state.pile.length} card${state.pile.length === 1 ? '' : 's'}${notes.length ? ` (${notes.join(', ')})` : ''}` : 'Pile';
}

$('#pileList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]')?.dataset.remove;
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (rm) {
    const entry = state.pile.find((x) => x.id === rm);
    state.pile = state.pile.filter((x) => x.id !== rm);
    await savePile();
    if (entry) toast(`${entry.name} taken off the pile`, { action: 'Undo', onAction: async () => { state.pile.unshift(entry); await savePile(); } });
  } else if (open) openPileSheet(open);
});

async function movePileToCollection(entries) {
  for (const e of entries) {
    const dup = live().find((i) => i.cardId === e.cardId && i.lang === e.lang && i.variant === e.variant && i.condition === e.condition);
    if (dup) await saveItems({ ...dup, qty: dup.qty + 1, prices: e.prices || dup.prices, updatedAt: Date.now() });
    else await saveItems({ ...e, id: uid(), profile: state.profileId, updatedAt: Date.now() });
  }
  const ids = new Set(entries.map((e) => e.id));
  state.pile = state.pile.filter((e) => !ids.has(e.id));
  await savePile();
  brandMood('happy');
  toast(`${entries.length} card${entries.length === 1 ? '' : 's'} added to your collection`, { kind: 'ok' });
}

$('#pileToCollection').addEventListener('click', () => movePileToCollection(state.pile.slice()));
$('#pileClear').addEventListener('click', async () => {
  const old = state.pile.slice();
  state.pile = [];
  await savePile();
  toast('Pile cleared', { action: 'Undo', onAction: async () => { state.pile = old; await savePile(); } });
});

// ---------- collection ----------
function renderCollection() {
  const all = live();
  const cur = displayCur();
  const q = norm($('#collSearch').value);
  let list = q ? all.filter((i) => norm(`${i.name} ${i.setName} ${i.localId} ${numLabel(i)}`).includes(q)) : all.slice();
  const sort = $('#collSort').value;
  // qtyOf/str: tolerate items saved before imports were cleaned (missing or text fields)
  const qtyOf = (i) => Math.max(0, Number(i.qty) || 0);
  const str = (v) => (v == null ? '' : String(v));
  const sortValue = (i) => valueOf(i) ?? priceEntry(i)?.v ?? -1;
  if (sort === 'value') list.sort((a, b) => sortValue(b) * qtyOf(b) - sortValue(a) * qtyOf(a));
  else if (sort === 'name') list.sort((a, b) => str(a.name).localeCompare(str(b.name)));
  else if (sort === 'set') list.sort((a, b) => str(a.setName).localeCompare(str(b.setName)) || str(a.localId).localeCompare(str(b.localId), undefined, { numeric: true }));
  else list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  let count = 0; let value = 0; let paid = 0; let paidValue = 0; let hasPaid = false; let otherOnly = 0;
  for (const i of all) {
    const q = qtyOf(i);
    count += q;
    const v = valueOf(i);
    if (v != null) value += v * q;
    else if (priceEntry(i)) otherOnly += q;
    if (i.paid != null && i.paidCur === cur) { hasPaid = true; paid += Number(i.paid) || 0; paidValue += (v ?? 0) * q; }
  }
  const p = profile();
  $('#collTitle').textContent = p ? `${p.name}'s collection` : 'My collection';
  $('#stats').innerHTML = `
    <div class="stat"><small>Cards</small><b>${count.toLocaleString()}</b></div>
    <div class="stat"><small>Worth</small><b>${esc(money(value, cur))}</b></div>
    ${hasPaid ? `<div class="stat"><small>Paid</small><b>${esc(money(paid, cur))}</b></div>
    <div class="stat"><small>${paidValue - paid >= 0 ? 'Profit' : 'Loss'}</small><b>${paidValue - paid >= 0 ? '+' : '−'}${esc(money(Math.abs(paidValue - paid), cur))}</b></div>` : ''}
    ${otherOnly ? `<p class="tiny muted stats-note">${otherOnly.toLocaleString()} card${otherOnly === 1 ? '' : 's'} only ${otherOnly === 1 ? 'has' : 'have'} a ${SOURCE_LABEL[otherSrc()]} price, so ${otherOnly === 1 ? "it isn't" : "they aren't"} in the worth.</p>` : ''}`;
  $('#collEmpty').hidden = all.length > 0;
  $('#collGrid').innerHTML = list.map((i) => `<button class="tile" type="button" data-item="${esc(i.id)}">
      ${i.qty > 1 ? `<span class="qty">×${i.qty}</span>` : ''}
      ${img(i.image)}
      <span class="name">${esc(i.name)}</span>
      <span class="meta">${[i.setName, numLabel(i), i.variant !== 'normal' && VARIANT_LABEL[i.variant]].filter(Boolean).map(esc).join(' · ')}</span>
      ${stickerOf(i)}
    </button>`).join('') + (all.length && !list.length ? '<p class="muted">Nothing matches that search.</p>' : '');
  const badge = $('#collBadge');
  badge.hidden = !count;
  badge.textContent = count > 999 ? '999+' : String(count);
}

$('#collGrid').addEventListener('click', (e) => {
  const id = e.target.closest('[data-item]')?.dataset.item;
  if (id) openItemSheet(id);
});
$('#collSearch').addEventListener('input', debounce(renderCollection, 120));
$('#collSort').addEventListener('change', renderCollection);

$('#refreshPrices').addEventListener('click', async () => {
  const btn = $('#refreshPrices');
  const label = btn.querySelector('span');
  const all = live();
  if (!all.length || btn.disabled) return;
  btn.disabled = true;
  try {
    const keys = [...new Set(all.map((i) => i.lang + '|' + i.cardId))];
    let done = 0;
    const fulls = new Map();
    await pool(keys, 4, async (k) => {
      const [lang, id] = k.split('|');
      try { fulls.set(k, await getCard(id, lang)); } catch { /* keep old price */ }
      label.textContent = `Refreshing ${++done}/${keys.length}…`;
    });
    const now = Date.now();
    const changed = all.filter((i) => fulls.has(i.lang + '|' + i.cardId)).map((i) => {
      const full = fulls.get(i.lang + '|' + i.cardId);
      return { ...i, prices: pricesFor(full, i.variant), rarity: i.rarity || full.rarity || null, pricedAt: now, updatedAt: now };
    });
    if (changed.length) await saveItems(changed);
    // v4: say so when nothing could be fetched, instead of "Prices updated for 0 cards"
    if (changed.length) toast(`Prices updated for ${changed.length} card${changed.length === 1 ? '' : 's'}`, { kind: 'ok' });
    else toast("Couldn't reach the price service. Your old prices are kept.", { kind: 'err' });
  } finally {
    // v4: the button can never stay stuck on "Refreshing…" if saving fails
    label.textContent = 'Refresh prices';
    btn.disabled = false;
  }
});

// ---------- profiles ----------
function renderProfileBtn() {
  const p = profile();
  if (!p) return;
  $('#profileAvatar').textContent = p.avatar;
  $('#profileAvatar').style.setProperty('--av', p.color);
  $('#profileName').textContent = p.name;
}

function renderProfiles() {
  $('#profileList').innerHTML = state.profiles.map((p) => `<div class="profile-row ${p.id === state.profileId ? 'current' : ''}">
      <span class="avatar" style="--av:${esc(p.color)}">${esc(p.avatar)}</span>
      <span class="who">${esc(p.name)}<small>${p.id === state.profileId ? 'Using now' : 'Tap to switch'}${p.sync?.code ? ' · syncs' : ''}</small></span>
      ${p.id === state.profileId ? '' : `<button class="btn btn-small" type="button" data-switch="${esc(p.id)}">Switch</button>`}
      <button class="x-btn" type="button" data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}"><svg><use href="#i-pencil"/></svg></button>
    </div>`).join('');
}

function profileEditor(p, { welcome = false } = {}) {
  const draft = p ? { ...p } : { id: uid(), name: '', avatar: AVATARS[(state.profiles.length) % AVATARS.length], color: COLORS[state.profiles.length % COLORS.length], sync: null, createdAt: Date.now() };
  const body = $('#profileBody');
  const render = () => {
    body.innerHTML = `
      <div class="${welcome ? 'welcome' : ''}">
        ${welcome ? `<span data-mascot="happy"></span><h2>Hi! I'm Schatje.</h2><p class="muted">I'll help you find out what your cards are worth. Who's collecting?</p>` : `<h2>${p ? 'Edit profile' : 'New profile'}</h2>`}
      </div>
      <label class="field labelled"><span>Name</span><input id="pfName" type="text" maxlength="30" value="${esc(draft.name)}" placeholder="e.g. Julie" autocomplete="nickname"></label>
      <p class="tiny muted" style="margin:6px 0 0">Pick a buddy</p>
      <div class="avatar-grid">${AVATARS.map((a) => `<button type="button" data-av="${a}" aria-pressed="${a === draft.avatar}">${a}</button>`).join('')}</div>
      <div class="color-row">${COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" aria-pressed="${c === draft.color}" aria-label="Colour ${c}"></button>`).join('')}</div>
      <div class="actions">
        ${p && state.profiles.length > 1 && !welcome ? '<button class="btn btn-small btn-red" type="button" data-pf="delete"><svg><use href="#i-trash"/></svg>Delete profile</button>' : ''}
        <button class="btn btn-yellow" type="button" data-pf="save"><svg><use href="#i-check"/></svg>${welcome ? "Let's go!" : 'Save'}</button>
      </div>`;
    hydrateMascots(body);
  };
  render();
  body.onclick = async (e) => {
    const av = e.target.closest('[data-av]')?.dataset.av;
    const color = e.target.closest('[data-color]')?.dataset.color;
    const act = e.target.closest('[data-pf]')?.dataset.pf;
    if (av || color) {
      draft.name = $('#pfName').value;
      if (av) draft.avatar = av;
      if (color) draft.color = color;
      render();
    } else if (act === 'save') {
      draft.name = $('#pfName').value.trim() || 'Collector';
      const i = state.profiles.findIndex((x) => x.id === draft.id);
      if (i >= 0) state.profiles[i] = draft; else state.profiles.push(draft);
      saveProfiles();
      closeDialog($('#profileDlg'));
      if (draft.id !== state.profileId && !p) await switchProfile(draft.id);
      else { renderProfileBtn(); renderProfiles(); renderCollection(); }
    } else if (act === 'delete') {
      if (!confirmBox(`Delete ${draft.name}'s profile and collection from this device? This can't be undone (unless it syncs or you have a backup).`)) return;
      await itemsDeleteProfile(draft.id);
      await kvDel('pile:' + draft.id);
      state.profiles = state.profiles.filter((x) => x.id !== draft.id);
      if (state.profileId === draft.id) state.profileId = state.profiles[0].id;
      saveProfiles();
      closeDialog($('#profileDlg'));
      await switchProfile(state.profileId);
    }
  };
  showDialog($('#profileDlg'));
  setTimeout(() => $('#pfName')?.focus(), 60);
}

function profileSwitcher() {
  const body = $('#profileBody');
  body.innerHTML = `<h2>Who's collecting?</h2>
    <p class="muted">Each profile has its own collection and pile, kept in this browser.</p>
    <div class="profile-list">${state.profiles.map((p) => `<button class="profile-row ${p.id === state.profileId ? 'current' : ''}" type="button" data-switch="${esc(p.id)}" style="cursor:pointer;font:inherit;color:inherit;text-align:left">
      <span class="avatar" style="--av:${esc(p.color)}">${esc(p.avatar)}</span><span class="who">${esc(p.name)}<small>${p.id === state.profileId ? 'Using now' : 'Switch to this profile'}</small></span></button>`).join('')}</div>
    <div class="actions"><button class="btn btn-small" type="button" data-pf="new"><svg><use href="#i-plus"/></svg>New profile</button>
    <button class="btn btn-small" type="button" data-pf="edit"><svg><use href="#i-pencil"/></svg>Edit mine</button></div>`;
  body.onclick = async (e) => {
    const id = e.target.closest('[data-switch]')?.dataset.switch;
    const act = e.target.closest('[data-pf]')?.dataset.pf;
    if (id) { closeDialog($('#profileDlg')); if (id !== state.profileId) await switchProfile(id); }
    else if (act === 'new') profileEditor(null);
    else if (act === 'edit') profileEditor(profile());
  };
  showDialog($('#profileDlg'));
}

$('#profileBtn').addEventListener('click', profileSwitcher);
$('#addProfile').addEventListener('click', () => profileEditor(null));
$('#profileList').addEventListener('click', async (e) => {
  const sw = e.target.closest('[data-switch]')?.dataset.switch;
  const ed = e.target.closest('[data-edit]')?.dataset.edit;
  if (sw) await switchProfile(sw);
  else if (ed) profileEditor(state.profiles.find((p) => p.id === ed));
});

async function switchProfile(id) {
  state.profileId = id;
  saveProfiles();
  state.pending = null;
  $('#mini').hidden = true;
  await loadProfileData();
  renderAll();
  toast(`Hi ${profile().name}!`, { kind: 'ok', ms: 1800 });
  runSync();
}

async function loadProfileData() {
  state.items = await itemsOf(state.profileId).catch(() => []);
  state.pile = (await kvGet('pile:' + state.profileId).catch(() => null)) || [];
}

const confirmBox = (msg) => window.confirm(msg);

// ---------- sync ----------
const syncSoon = debounce(() => runSync(), 5000);

async function runSync() {
  const p = profile();
  if (!p?.sync?.code || state.syncBusy) return;
  const pid = p.id;
  state.syncBusy = true;
  renderSyncBox();
  try {
    const { items, changedLocal } = await syncItems(p.sync.code, state.items);
    if (state.profileId === pid && changedLocal) {
      const mine = items.map((i) => ({ ...i, profile: pid }));
      await itemsPut(mine);
      state.items = mine;
      renderCollection();
    }
    p.sync.last = Date.now();
    state.syncError = null;
    saveProfiles();
  } catch (e) {
    state.syncError = e.message || 'Sync failed.';
  } finally {
    state.syncBusy = false;
    renderSyncBox();
  }
}

function renderSyncBox() {
  const box = $('#syncBox');
  const p = profile();
  if (!p) return;
  if (state.syncServer === undefined) {
    state.syncServer = null;
    serverAvailable().then((ok) => { state.syncServer = ok; renderSyncBox(); });
  }
  const intro = '<p class="muted">Want the same collection on your phone and your laptop? Make a secret sync code here and type it on your other device. No account needed: your collection is encrypted before it leaves this device.</p>';
  if (state.syncServer === false && !p.sync?.code) {
    box.innerHTML = `${intro}<p class="tiny muted">Sync only works on the online version of Schatkaart (the Cloudflare Worker). Here your collection stays on this device; use Backup to move it.</p>`;
    return;
  }
  if (!p.sync?.code) {
    box.innerHTML = `${intro}
      <div class="sync-row"><button class="btn btn-small btn-sky" type="button" data-sync="create"><svg><use href="#i-cloud"/></svg>Make a sync code</button></div>
      <div class="sync-row"><label class="field" style="flex:1 1 220px"><input id="syncCodeIn" type="text" aria-label="Sync code from your other device" placeholder="Have a code? XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <button class="btn btn-small" type="button" data-sync="link">Link</button></div>`;
    return;
  }
  box.innerHTML = `
    <p class="muted">${esc(p.name)}'s collection syncs with this code. Type it on your other device. Keep it secret: anyone with the code can see and change this collection.</p>
    <div class="sync-row"><span class="code">${esc(p.sync.code)}</span><button class="btn btn-small" type="button" data-sync="copy">Copy</button></div>
    <p class="tiny ${state.syncError ? '' : 'muted'}" style="${state.syncError ? 'color:var(--red);font-weight:600' : ''}">${state.syncBusy ? 'Syncing…' : state.syncError ? esc(state.syncError) : p.sync.last ? `Last synced ${new Date(p.sync.last).toLocaleString()}` : 'Not synced yet'}</p>
    <div class="sync-row">
      <button class="btn btn-small btn-sky" type="button" data-sync="now" ${state.syncBusy ? 'disabled' : ''}><svg><use href="#i-refresh"/></svg>Sync now</button>
      <button class="btn btn-small" type="button" data-sync="unlink">Stop syncing here</button>
      <button class="btn btn-small btn-ghost" type="button" data-sync="wipe">Delete online copy</button>
    </div>`;
}

$('#syncBox').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-sync]')?.dataset.sync;
  const p = profile();
  if (!act || !p) return;
  if (act === 'create') {
    p.sync = { code: newCode(), last: null };
    saveProfiles();
    renderSyncBox();
    runSync();
  } else if (act === 'link') {
    const code = cleanCode($('#syncCodeIn').value);
    if (!code) { toast("That code doesn't look right: it has 20 letters and digits.", { kind: 'err' }); return; }
    p.sync = { code, last: null };
    saveProfiles();
    await runSync();
    if (!state.syncError) toast('Linked! Your collections are merged.', { kind: 'ok' });
  } else if (act === 'copy') {
    try { await navigator.clipboard.writeText(p.sync.code); toast('Code copied', { kind: 'ok', ms: 1600 }); } catch { toast('Copy failed: select the code and copy it by hand.', { kind: 'err' }); }
  } else if (act === 'now') runSync();
  else if (act === 'unlink') {
    if (!confirmBox('Stop syncing this profile on this device? Your collection stays here and online.')) return;
    p.sync = null; state.syncError = null; saveProfiles(); renderSyncBox();
  } else if (act === 'wipe') {
    if (!confirmBox('Delete the online copy? Other devices with this code will stop syncing. The collection on this device stays.')) return;
    try { await deleteRemote(p.sync.code); p.sync = null; state.syncError = null; saveProfiles(); renderSyncBox(); toast('Online copy deleted', { kind: 'ok' }); } catch (err) { toast(err.message, { kind: 'err' }); }
  }
});

// ---------- backup ----------
$('#exportJson').addEventListener('click', () => {
  const p = profile();
  const data = { app: 'schatkaart', v: 1, exportedAt: new Date().toISOString(), profile: { name: p.name }, items: live().map(({ profile: _, ...rest }) => rest) };
  download(`schatkaart-${norm(p.name).replace(/ /g, '-') || 'collection'}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
});

$('#exportCsv').addEventListener('click', () => {
  const cur = displayCur();
  const rows = [['Name', 'Set', 'Number', 'Variant', 'Condition', 'Quantity', `Price each (${cur})`, `Total (${cur})`, 'Paid', 'Notes', 'Added']];
  for (const i of live()) {
    const v = valueOf(i);
    rows.push([i.name, i.setName, numLabel(i), VARIANT_LABEL[i.variant] || i.variant, i.condition, i.qty,
      v == null ? '' : v.toFixed(2), v == null ? '' : (v * i.qty).toFixed(2), i.paid == null ? '' : i.paid.toFixed(2), i.notes || '',
      new Date(i.addedAt).toISOString().slice(0, 10)]);
  }
  const csv = rows.map((r) => r.map((x) => {
    const s = String(x ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  download(`schatkaart-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + csv, 'text/csv');
});

// A backup may be hand-edited or come from an older version: give every item a valid shape, so the
// totals never turn into NaN (a missing or text qty did that) and sorting never trips over a missing field.
function cleanImported(i) {
  const now = Date.now();
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    ...i,
    id: String(i.id),
    cardId: String(i.cardId),
    name: String(i.name),
    lang: typeof i.lang === 'string' && i.lang ? i.lang : state.settings.lang,
    setName: typeof i.setName === 'string' ? i.setName : '',
    localId: i.localId == null ? '' : String(i.localId),
    image: typeof i.image === 'string' ? i.image : null,
    variant: VARIANT_LABEL[i.variant] ? i.variant : 'normal',
    condition: typeof i.condition === 'string' && i.condition ? i.condition : 'NM',
    qty: Math.min(9999, Math.max(1, Math.floor(num(i.qty) ?? 1))),
    paid: num(i.paid),
    prices: i.prices && typeof i.prices === 'object' ? i.prices : { cardmarket: null, tcgplayer: null },
    addedAt: Number.isFinite(i.addedAt) ? i.addedAt : now,
    updatedAt: Number.isFinite(i.updatedAt) ? i.updatedAt : now,
  };
}

$('#importJson').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data.items) ? data.items : []).filter((i) => i && i.id && i.cardId && i.name);
    if (!incoming.length) throw new Error('empty');
    const merged = mergeItems(state.items, incoming.map(cleanImported))
      .map((i) => ({ ...i, profile: state.profileId }));
    await itemsPut(merged);
    state.items = merged;
    renderCollection();
    syncSoon();
    toast(`Imported ${incoming.length} card${incoming.length === 1 ? '' : 's'}`, { kind: 'ok' });
  } catch {
    toast("That file isn't a Schatkaart backup.", { kind: 'err' });
  }
});

$('#wipeProfile').addEventListener('click', async () => {
  const p = profile();
  if (!confirmBox(`Erase ${p.name}'s whole collection and pile on this device? This can't be undone.`)) return;
  const now = Date.now();
  // Keep deletion markers so a synced copy is emptied too.
  const markers = live().map((i) => ({ id: i.id, profile: i.profile, deleted: true, updatedAt: now }));
  if (markers.length) await saveItems(markers);
  state.pile = [];
  await savePile();
  toast('Collection erased', { kind: 'ok' });
});

// ---------- settings ----------
// v4: the segmented controls (theme, price source, "Found cards go to") work like real radio groups:
// one Tab stop on the checked option, arrow keys (and Home/End) move to the next option and pick it.
function setChecked(group, isOn) {
  for (const b of $$('[role="radio"]', group)) {
    const on = isOn(b);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
const RADIO_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
for (const group of $$('[role="radiogroup"]')) {
  group.addEventListener('keydown', (e) => {
    const radios = $$('[role="radio"]', group);
    const i = radios.indexOf(e.target);
    if (i < 0) return;
    let j;
    if (e.key in RADIO_KEYS) j = (i + RADIO_KEYS[e.key] + radios.length) % radios.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = radios.length - 1;
    else return;
    e.preventDefault();
    radios[j].focus();
    radios[j].click();
  });
}

function renderSettings() {
  setChecked($('#sourceSeg'), (b) => b.dataset.source === state.settings.source);
  $('#langSel').innerHTML = Object.entries(LANGS).map(([k, l]) => `<option value="${k}" ${k === state.settings.lang ? 'selected' : ''}>${l}</option>`).join('');
  renderDbStatus();
  renderProfiles();
  renderSyncBox();
  renderTheme();
}

// ---------- theme (v2): auto / light / dark ----------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => state.settings.theme === 'dark' || ((state.settings.theme || 'auto') === 'auto' && darkQuery.matches);

function applyTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('meta[name="theme-color"]').content = isDark() ? '#1b1230' : '#ffd23f';
  $('#themeBtn').setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  renderTheme();
}

function renderTheme() {
  const t = state.settings.theme || 'auto';
  setChecked($('#themeSeg'), (b) => b.dataset.themeOpt === t);
}

function setTheme(t) {
  state.settings.theme = t;
  saveSettings();
  applyTheme();
}

$('#themeSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-theme-opt]')?.dataset.themeOpt;
  if (t) setTheme(t);
});
// The header button flips to the opposite of what you see right now.
$('#themeBtn').addEventListener('click', () => {
  setTheme(isDark() ? 'light' : 'dark');
  brandMood(isDark() ? 'sleep' : 'happy', 1600);
});
darkQuery.addEventListener?.('change', () => { if ((state.settings.theme || 'auto') === 'auto') applyTheme(); });

$('#sourceSeg').addEventListener('click', (e) => {
  const s = e.target.closest('[data-source]')?.dataset.source;
  if (!s) return;
  state.settings.source = s;
  saveSettings();
  renderAll();
});

$('#langSel').addEventListener('change', (e) => {
  state.settings.lang = e.target.value;
  saveSettings();
  state.cat = null;
  ensureCatalog().catch(() => {});
});

$('#dbUpdate').addEventListener('click', () => ensureCatalog(true).then(() => toast('Card list is up to date', { kind: 'ok' })).catch(() => toast("Couldn't update the card list.", { kind: 'err' })));

function renderTarget() {
  setChecked($('#targetSeg'), (b) => b.dataset.target === state.settings.target);
}
$('#targetSeg').addEventListener('click', (e) => {
  const t = e.target.closest('[data-target]')?.dataset.target;
  if (!t) return;
  state.settings.target = t;
  saveSettings();
  renderTarget();
});

// ---------- scan controls ----------
// Taking a photo works far more reliably on phones than the live camera view.
$('#startCam').addEventListener('click', () => $('#fileInput').click());
$('#shutter').addEventListener('click', () => $('#fileInput').click());
$('#torchBtn').addEventListener('click', async () => {
  try { $('#torchBtn').setAttribute('aria-pressed', String(await cam.toggleTorch())); } catch { toast("The flashlight can't be switched on.", { kind: 'err' }); }
});
$('#autoBtn').addEventListener('click', () => {
  state.auto = !state.auto;
  $('#autoBtn').setAttribute('aria-pressed', String(state.auto));
  lastScanThumb = null;
  if (state.auto && !cam.on) startCamera();
  toast(state.auto ? 'Auto scan on: hold each card still and Schatje scans it' : 'Auto scan off', { ms: 2200 });
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'upload') $('#fileInput').click();
  else if (a === 'search') openSearch();
});
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (state.view !== 'scan') location.hash = '#scan';
  scanFile(f);
});

onOcrProgress((m) => {
  if (m.status === 'ready') { ocrHint = ''; return; }
  const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : '';
  ocrHint = `Schatje is putting on reading glasses…${pct}`;
});

// ---------- routing ----------
function route() {
  const v = (location.hash || '#scan').slice(1);
  state.view = ['scan', 'collection', 'settings'].includes(v) ? v : 'scan';
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + state.view;
  for (const a of $$('.tabbar [data-tab]')) {
    if (a.dataset.tab === state.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (state.view === 'scan') {
    if (cam.on) { sizeOverlay(); startLoop(); }
  } else if (cam.on) {
    stopCamera(); // save battery while browsing the collection
    LS.set('camOn', true);
  }
  if (state.view === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}
addEventListener('hashchange', route);
addEventListener('resize', () => { if (cam.on) sizeOverlay(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { syncSoon.flush(); return; }
  if (cam.on && state.view === 'scan') startLoop();
  runSync();
});

function renderAll() {
  renderProfileBtn();
  renderTarget();
  renderPile();
  renderCollection();
  if (state.view === 'settings') renderSettings();
}

// ---------- start ----------
async function start() {
  hydrateMascots(document);
  applyTheme();
  let first = false;
  if (!state.profiles.length) {
    state.profiles = [{ id: uid(), name: 'Collector', avatar: '🦊', color: '#ffd23f', sync: null, createdAt: Date.now() }];
    first = true;
  }
  if (!profile()) state.profileId = state.profiles[0].id;
  saveProfiles();
  await loadProfileData();
  renderAll();
  route();
  if (first) profileEditor(profile(), { welcome: true });
  ensureCatalog().catch(() => {});
  runSync();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
