// Card recognition: OCR (Tesseract.js) reads the collector number and the name, both are matched
// against the local card index, and the photo is compared with the official card images to break ties.

import { imageUrl } from './catalog.js';
import { loadImage, loadScript, norm, normNum, pool, sim } from './util.js';

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
export const CARD_RATIO = 88 / 63; // height / width of a standard card

let workerP = null;
let progressCb = null;
export const onOcrProgress = (cb) => { progressCb = cb; };
export const ocrStarted = () => workerP !== null;

export function initOCR() {
  if (workerP) return workerP;
  workerP = (async () => {
    if (!window.Tesseract) await loadScript(TESSERACT);
    const w = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => { if (m.status !== 'recognizing text') progressCb?.(m); },
    });
    await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text: labels scattered across a strip
    progressCb?.({ status: 'ready', progress: 1 });
    return w;
  })();
  workerP.catch(() => { workerP = null; });
  return workerP;
}

// ---------- image preparation ----------

function region(src, rx, ry, rw, rh, outW, invert = null) {
  const sw = src.width * rw;
  const sh = src.height * rh;
  const c = document.createElement('canvas');
  c.width = Math.round(outW);
  c.height = Math.max(1, Math.round((sh * outW) / sw));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, src.width * rx, src.height * ry, sw, sh, 0, 0, c.width, c.height);
  enhance(g, c.width, c.height, invert);
  return c;
}

// Grayscale + contrast stretch; flips light-on-dark text so Tesseract always sees dark text.
function enhance(g, w, h, forceInvert) {
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  const n = w * h;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    lum[p] = y;
    hist[y]++;
  }
  let acc = 0; let lo = 0; let hi = 255; let med = 128;
  const a = n * 0.02; const b = n * 0.98; const m = n * 0.5;
  for (let v = 0; v < 256; v++) {
    const prev = acc;
    acc += hist[v];
    if (prev < a && acc >= a) lo = v;
    if (prev < m && acc >= m) med = v;
    if (prev < b && acc >= b) hi = v;
  }
  const invert = forceInvert ?? med < 105;
  const span = Math.max(1, hi - lo);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    let y = ((lum[p] - lo) * 255) / span;
    if (invert) y = 255 - y;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.putImageData(im, 0, 0);
  return invert;
}

async function ocr(w, canvas) {
  const { data } = await w.recognize(canvas);
  return data.text || '';
}

// ---------- collector numbers ----------

const PREFIXES = ['SWSH', 'HGSS', 'SVP', 'SV', 'SM', 'XY', 'BW', 'DP', 'TG', 'GG', 'RC', 'SL', 'SH', 'RT', 'CC', 'AR', 'H'];
const DIGITISH = '0-9OQDIL|!\\[\\]SBZG';
const fixDigits = (s) => s
  .replace(/[OQD]/g, '0')
  .replace(/[IL|!\][]/g, '1')
  .replace(/S/g, '5')
  .replace(/B/g, '8')
  .replace(/Z/g, '2')
  .replace(/G/g, '6');

function numVariants(raw) {
  const s = raw.replace(/\s+/g, '');
  const out = new Set();
  const add = (v) => { v = normNum(v); if (/\d/.test(v) && v.length <= 8) out.add(v); };
  for (const p of PREFIXES) {
    if (s.startsWith(p) && s.length > p.length && s.length - p.length <= 4) add(p + fixDigits(s.slice(p.length)));
  }
  if (/^\d{1,3}[A-Z]?$/.test(s)) add(s);
  const tail = s.match(new RegExp(`[${DIGITISH}]{1,3}$`));
  if (tail && /\d/.test(tail[0])) add(fixDigits(tail[0]));
  return [...out];
}

/** Find things that look like "136/189", "TG05/TG30", "SWSH050" in OCR text. */
export function parseNumbers(text) {
  const T = text.toUpperCase();
  const out = [];
  const re = new RegExp(`([A-Z${DIGITISH}]{1,8})\\s?[/⁄∕]\\s?([A-Z${DIGITISH}]{1,8})`, 'g');
  let m;
  while ((m = re.exec(T))) {
    const [, L, R] = m;
    if (!/\d/.test(L) && !/\d/.test(R)) continue;
    const nums = numVariants(L);
    if (!nums.length) continue;
    let totalNum = null;
    let totalStr = null;
    const rr = R.match(new RegExp(`^([A-Z]{0,4}?)([${DIGITISH}]{1,3})`));
    if (rr) {
      const digits = fixDigits(rr[2]);
      if (!rr[1] && /^\d+$/.test(digits)) totalNum = parseInt(digits, 10);
      else totalStr = normNum(rr[1] + digits);
    }
    out.push({ raw: m[0], nums, totalNum, totalStr });
  }
  // OCR often reads the slash as 1, 7 or l: "238/191" -> "2381191" or "2387191". Try each split;
  // matching keeps only splits that exist (card number + set size), so wrong guesses fall away.
  const runs = T.match(new RegExp(`[${DIGITISH}]{5,8}`, 'g')) || [];
  for (const run of runs) {
    const s = fixDigits(run);
    if (!/^\d+$/.test(s)) continue;
    for (let i = 1; i < s.length - 1; i++) {
      if (!'17'.includes(s[i])) continue;
      const L = s.slice(0, i);
      for (const R of [s.slice(i + 1), s.slice(i + 1, i + 4)]) {
        if (L.length > 3 || R.length < 2 || R.length > 3) continue;
        out.push({ raw: `${L}/${R}?`, nums: [normNum(L)], totalNum: parseInt(R, 10), guess: true });
      }
    }
  }
  const promo = /\b(SWSH|HGSS|SVP|SM|XY|BW|DP)\s?(?:EN\s?)?(\d{1,3}[A-Z]?)\b/g;
  while ((m = promo.exec(T))) {
    if (m[1] === 'SVP') out.push({ raw: m[0], nums: [normNum(m[2])], setId: 'svp', promo: true });
    else out.push({ raw: m[0], nums: [normNum(m[1] + m[2])], promo: true });
  }
  return out;
}

// ---------- names ----------

function windows(text) {
  const toks = norm(text).split(' ').filter(Boolean);
  const byK = [];
  for (let k = 1; k <= 5; k++) {
    const list = [];
    for (let i = 0; i + k <= toks.length; i++) list.push(toks.slice(i, i + k).join(''));
    byK[k] = list;
  }
  return byK;
}

function nameScore(flat, words, wins) {
  const L = flat.length;
  if (!L) return 0;
  let best = 0;
  const slack = Math.max(2, L * 0.34);
  for (let k = Math.max(1, words - 1); k <= Math.min(5, words + 1); k++) {
    for (const w of wins[k] || []) {
      if (Math.abs(w.length - L) > slack) continue;
      const s = sim(w, flat);
      if (s > best) { best = s; if (s === 1) break; }
    }
    if (best === 1) break;
  }
  if (L <= 4 && best < 1) best *= 0.75; // short names (Mew, Muk, Onix) match noise too easily
  return best;
}

// ---------- image similarity ----------

const DW = 16;
const DH = 22;
function descriptor(src) {
  const c = document.createElement('canvas');
  c.width = DW;
  c.height = DH;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, DW, DH);
  const d = g.getImageData(0, 0, DW, DH).data;
  const v = new Float32Array(DW * DH * 3);
  let mean = 0;
  for (let p = 0, j = 0; j < v.length; p += 4) { v[j++] = d[p]; v[j++] = d[p + 1]; v[j++] = d[p + 2]; }
  for (const x of v) mean += x;
  mean /= v.length;
  let sd = 0;
  for (const x of v) sd += (x - mean) ** 2;
  sd = Math.sqrt(sd / v.length) || 1;
  for (let j = 0; j < v.length; j++) v[j] = (v[j] - mean) / sd;
  return v;
}

function corr(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

const descCache = new Map();
async function cardDescriptor(card) {
  if (!card.image) return null;
  if (descCache.has(card.id)) return descCache.get(card.id);
  const p = Promise.race([
    loadImage(imageUrl(card.image, 'low')).then(descriptor),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]).catch(() => null);
  descCache.set(card.id, p);
  const v = await p;
  if (!v) descCache.delete(card.id);
  return v;
}

// ---------- matching ----------

function gather(cat, nums, text) {
  const wins = windows(text);
  const found = new Map();
  const add = (card, num) => {
    const e = found.get(card.id);
    if (!e) found.set(card.id, { card, num, name: 0, img: null });
    else if (num > e.num) e.num = num;
  };
  for (const n of nums) {
    for (const v of n.nums) {
      let list = cat.byNum.get(v);
      if (!list) continue;
      if (n.setId) list = list.filter((c) => c.setId === n.setId);
      for (const c of list) {
        if (n.guess && c.set.official !== n.totalNum && c.set.total !== n.totalNum) continue;
        let s;
        if (n.totalNum != null) s = c.set.official === n.totalNum ? 1 : c.set.total === n.totalNum ? 0.95 : 0.45;
        else if (n.totalStr) s = 0.85;
        else s = n.promo ? 0.85 : 0.5;
        add(c, s);
      }
    }
  }
  // Names anywhere in the text, so cards are still found when the number is unreadable.
  const nameHits = [];
  for (const nm of cat.names) {
    const s = nameScore(nm.flat, nm.words, wins);
    if (s >= 0.72) nameHits.push({ nm, s });
  }
  nameHits.sort((a, b) => b.s - a.s || b.nm.flat.length - a.nm.flat.length);
  const nameScoreOf = new Map(nameHits.map((h) => [h.nm.n, h.s]));
  for (const h of nameHits.slice(0, 5)) for (const c of h.nm.cards) add(c, 0);
  for (const e of found.values()) {
    e.name = nameScoreOf.get(e.card.n) ?? nameScore(e.card.n.replace(/ /g, ''), e.card.n.split(' ').length, wins);
  }
  return [...found.values()];
}

function score(e) {
  const img = e.img ?? (e.card.image ? 0.4 : 0.2);
  return e.num > 0 ? 0.5 * e.num + 0.35 * e.name + 0.15 * img : 0.55 * e.name + 0.3 * img;
}

function rank(list) {
  for (const e of list) e.score = score(e);
  return list.sort((a, b) => b.score - a.score || b.card.set.order - a.card.set.order);
}

/**
 * Every print of a card with the same name, ranked by how closely its artwork matches the photo.
 * Reprints share art but differ in set, number and price, so the user confirms the exact one.
 */
export async function versionsOf(cat, card, photo, limit = 40) {
  const same = (cat.names.find((nm) => nm.n === card.n)?.cards || [card]).slice();
  same.sort((a, b) => b.set.order - a.set.order);
  const list = same.slice(0, limit).map((c) => ({ card: c, img: null }));
  if (photo && list.length > 1) {
    const ref = descriptor(photo);
    await pool(list, 6, async (e) => {
      const v = await cardDescriptor(e.card);
      if (v) e.img = corr(ref, v);
    });
    const top = list.find((e) => e.card.id === card.id)?.img ?? Math.max(...list.map((e) => e.img ?? -1));
    for (const e of list) e.sameArt = e.img != null && top != null && e.img >= Math.min(0.82, top - 0.08);
    list.sort((a, b) => (b.sameArt - a.sameArt) || ((b.img ?? -1) - (a.img ?? -1)));
  }
  return list;
}

/**
 * Recognise a card from a canvas that holds just the card (portrait, roughly 63:88).
 * Returns ranked candidates and whether the top one is a confident match.
 */
export async function recognize(cat, card, { onStage } = {}) {
  const w = await initOCR();
  onStage?.('Reading the number…');
  let numberText = await ocr(w, region(card, 0, 0.855, 1, 0.14, 1600));
  onStage?.('Reading the name…');
  const nameText = await ocr(w, region(card, 0, 0.012, 1, 0.19, 1400));
  let nums = parseNumbers(numberText);
  let list = gather(cat, nums, nameText + '\n' + numberText);

  if (!list.some((e) => e.num >= 0.85)) {
    // Second look: each bottom corner on its own, larger, in both polarities when needed.
    onStage?.('Looking closer…');
    const extra = [];
    for (const x of [0, 0.45]) extra.push(await ocr(w, region(card, x, 0.875, 0.55, 0.12, 1500)));
    numberText += '\n' + extra.join('\n');
    nums = parseNumbers(numberText);
    // Full-art cards print the number in light text over busy art: try both polarities on the corners.
    for (const [x, inv] of [[0, true], [0.45, true], [0, false], [0.45, false]]) {
      if (nums.some((n) => n.totalNum != null || n.promo)) break;
      numberText += '\n' + await ocr(w, region(card, x, 0.9, 0.55, 0.09, 1700, inv));
      nums = parseNumbers(numberText);
    }
    list = gather(cat, nums, nameText + '\n' + numberText);
  }

  rank(list);
  // Without a readable number, popular names (Charizard has ~100 prints) need a wider artwork search.
  const hasNum = list.some((e) => e.num >= 0.85);
  const top = list.slice(0, hasNum ? 24 : 64);
  if (top.length > 1) {
    onStage?.('Comparing artwork…');
    const ref = descriptor(card);
    await pool(top, 6, async (e) => {
      const v = await cardDescriptor(e.card);
      if (v) e.img = Math.max(0, Math.min(1, (corr(ref, v) - 0.25) / 0.6));
    });
    rank(top);
  } else if (top.length === 1) {
    top[0].img = 0.8;
    rank(top);
  }
  const [a, b] = top;
  const confident = !!a && a.score >= 0.7 && (!b || a.score - b.score >= 0.06);
  return {
    candidates: top.slice(0, 12),
    confident,
    debug: { numberText, nameText, nums },
  };
}
