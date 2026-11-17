// Card database from TCGdex (https://tcgdex.dev): a cached index of every card for matching,
// full card details on demand, and price helpers for Cardmarket (EUR) and TCGplayer (USD).

import { kvGet, kvSet } from './db.js';
import { norm, normNum, safeDecode, sim } from './util.js';

export const API = 'https://api.tcgdex.net/v2';
const INDEX_VERSION = 4; // 4: merged with data/extra-cards.json
const INDEX_MAX_AGE = 3 * 864e5; // refresh the index every few days so new sets show up

export const LANGS = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  it: 'Italiano',
  pt: 'Português',
  ja: '日本語',
};

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`TCGdex answered ${res.status}`);
  return res.json();
}

function build(lang, cards, sets, excluded) {
  const outSets = [];
  const setIds = new Set();
  sets.forEach((s, order) => {
    if (excluded.has(s.id)) return; // Pokémon TCG Pocket is digital-only
    setIds.add(s.id);
    outSets.push({
      id: s.id,
      name: s.name,
      official: s.cardCount?.official ?? 0,
      total: s.cardCount?.total ?? 0,
      logo: s.logo || null,
      symbol: null, // TCGdex symbol images currently answer 400, so they are not used
      order,
    });
  });
  const outCards = [];
  for (const c of cards) {
    const i = c.id.lastIndexOf('-');
    const setId = c.id.slice(0, i);
    if (!setIds.has(setId)) continue;
    const localId = safeDecode(c.localId);
    outCards.push({ id: c.id, setId, localId, name: c.name, image: c.image || null });
  }
  return { v: INDEX_VERSION, lang, builtAt: Date.now(), sets: outSets, cards: outCards };
}

function hydrate(raw) {
  const sets = new Map(raw.sets.map((s) => [s.id, s]));
  const byNum = new Map();
  const byName = new Map();
  const cards = raw.cards.map((c) => {
    const set = sets.get(c.setId);
    const card = { ...c, set, num: normNum(c.localId), n: norm(c.name) };
    card.hay = card.n + ' ' + norm(set.name);
    if (!byNum.has(card.num)) byNum.set(card.num, []);
    byNum.get(card.num).push(card);
    if (card.n) {
      if (!byName.has(card.n)) byName.set(card.n, []);
      byName.get(card.n).push(card);
    }
    return card;
  });
  const byId = new Map(cards.map((c) => [c.id, c]));
  const names = [...byName.entries()].map(([n, list]) => ({ n, flat: n.replace(/ /g, ''), words: n.split(' ').length, cards: list }));
  return { lang: raw.lang, builtAt: raw.builtAt, cards, sets, byNum, byId, names };
}

let current = null;
let loading = null;

export function catalog() { return current; }

/**
 * Load the index for a language. Uses the cached copy straight away and refreshes it in the
 * background when it is older than a few days; downloads it (≈2.4 MB for English) when missing.
 */
export function loadCatalog(lang, { force = false, onUpdate } = {}) {
  if (!force && current?.lang === lang) return Promise.resolve(current);
  if (!force && loading?.lang === lang) return loading.p;
  const p = (async () => {
    const cached = force ? null : await kvGet('catalog:' + lang).catch(() => null);
    const usable = cached && cached.v === INDEX_VERSION ? cached : null;
    if (usable) {
      current = hydrate(usable);
      if (Date.now() - usable.builtAt > INDEX_MAX_AGE) {
        download(lang).then((raw) => { if (current?.lang === lang) { current = hydrate(raw); onUpdate?.(current); } }).catch(() => {});
      }
      return current;
    }
    const raw = await download(lang);
    current = hydrate(raw);
    return current;
  })();
  loading = { lang, p };
  p.finally(() => { if (loading?.p === p) loading = null; });
  return p;
}

async function download(lang) {
  const [cards, sets, pocket, extra] = await Promise.all([
    getJSON(`${API}/${lang}/cards`),
    getJSON(`${API}/${lang}/sets`),
    getJSON(`${API}/${lang}/series/tcgp`).catch(() => ({ sets: [] })),
    lang === 'en' ? fetch('data/extra-cards.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  const raw = build(lang, cards, sets, new Set((pocket.sets || []).map((s) => s.id)));
  if (extra) mergeExtra(raw, extra);
  await kvSet('catalog:' + lang, raw).catch(() => {});
  return raw;
}

/**
 * Second source (data/extra-cards.json, built by scripts/build-extra-cards.mjs from the Pokémon TCG
 * data set): images and rarity where TCGdex has none, set codes and release dates, and cards that
 * TCGdex lacks. Extra cards get ids starting with "x:" and have no TCGdex details.
 */
function mergeExtra(raw, extra) {
  const sets = new Map(raw.sets.map((s) => [s.id, s]));
  for (const [id, e] of Object.entries(extra.sets || {})) {
    let s = sets.get(id);
    if (!s) {
      if (e.tcgdex) continue; // a TCGdex set that is left out on purpose (Pocket)
      s = { id, name: e.name, official: e.official ?? 0, total: e.total ?? 0, logo: null, symbol: null, order: -1, extra: true };
      sets.set(id, s);
      raw.sets.push(s);
    }
    s.code = e.code || null;
    s.released = e.released || null;
    s.series = e.series || null;
  }
  // Extra-only sets are slotted in by release date so "newest first" still holds.
  const dated = raw.sets.filter((s) => !s.extra && s.released).sort((a, b) => a.released.localeCompare(b.released));
  for (const s of raw.sets.filter((x) => x.extra)) {
    const before = dated.filter((d) => s.released && d.released <= s.released).pop();
    s.order = before ? before.order + 0.5 : -1;
  }
  for (const c of raw.cards) {
    const m = extra.more?.[c.id];
    if (!m) continue;
    if (!c.image && m[0]) c.image = m[0];
    if (m[1]) c.rarity = m[1];
  }
  for (const [setId, localId, name, image, rarity] of extra.cards || []) {
    if (!sets.has(setId)) continue;
    raw.cards.push({ id: `x:${setId}-${localId}`, setId, localId, name, image, rarity, extra: true });
  }
}

// ---------- full card details ----------

const cardCache = new Map();
export function getCard(id, lang) {
  const key = lang + ':' + id;
  if (cardCache.has(key)) return cardCache.get(key);
  const brief = current?.byId.get(id);
  // Cards from the second source have no TCGdex page: build a small card and look up its price.
  const p = brief?.extra
    ? withBackupPrices({ id, localId: brief.localId, name: brief.name, rarity: brief.rarity, image: brief.image, set: { id: brief.setId, name: brief.set.name }, variants: { normal: true } })
    : getJSON(`${API}/${lang}/cards/${id}`).then(withBackupPrices);
  cardCache.set(key, p);
  p.catch(() => cardCache.delete(key));
  return p;
}

export function imageUrl(image, quality = 'low') {
  if (!image) return null;
  // Images from the Pokémon TCG data set are full file URLs; the large one ends in _hires.png.
  if (!image.startsWith('https://assets.tcgdex.net')) {
    return quality === 'high' ? image.replace(/\.png$/i, '_hires.png').replace(/\/small$/, '/large') : image;
  }
  return `${image}/${quality}.webp`;
}

// ---------- manual search ----------

const NUM_TOKEN = /^[a-z]{0,4}\d{1,3}[a-z]?$/;

export function search(cat, query, limit = 60) {
  const q = norm(query.replace(/\//g, ' '));
  if (!cat || !q) return [];
  const toks = q.split(' ');
  const nums = toks.filter((t) => NUM_TOKEN.test(t));
  const words = toks.filter((t) => !NUM_TOKEN.test(t));
  let poolCards = cat.cards;
  if (nums.length) {
    poolCards = cat.byNum.get(normNum(nums[0])) || [];
    if (nums[1] && /^\d+$/.test(nums[1])) {
      const tot = parseInt(nums[1], 10);
      const filtered = poolCards.filter((c) => c.set.official === tot || c.set.total === tot);
      if (filtered.length) poolCards = filtered;
    }
  }
  let hits = poolCards;
  if (words.length) {
    hits = poolCards.filter((c) => words.every((w) => c.hay.includes(w)));
    if (!hits.length && words.length) {
      // Typo tolerance: closest names by similarity.
      const target = words.join('');
      const best = cat.names
        .map((nm) => ({ nm, s: sim(nm.flat, target) }))
        .filter((x) => x.s >= 0.7)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      const ok = new Set(best.flatMap((x) => x.nm.cards));
      hits = poolCards.filter((c) => ok.has(c));
    }
  }
  const phrase = words.join(' ');
  return hits
    .map((c) => ({ c, rank: (phrase && c.n === phrase ? 2 : 0) + (phrase && c.n.startsWith(phrase) ? 1 : 0) }))
    .sort((a, b) => b.rank - a.rank || b.c.set.order - a.c.set.order || a.c.num.localeCompare(b.c.num, undefined, { numeric: true }))
    .slice(0, limit)
    .map((x) => x.c);
}

// ---------- prices ----------

export const VARIANT_LABEL = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  firstEdition: '1st edition',
};

export function variantsOf(card) {
  const v = card?.variants || {};
  const out = ['normal', 'holo', 'reverse', 'firstEdition'].filter((k) => v[k]);
  return out.length ? out : ['normal'];
}

const pos = (x) => (typeof x === 'number' && x > 0 ? x : null);

const TCGP_KEYS = {
  normal: ['normal', 'unlimitedNormal', 'unlimited'],
  holo: ['holofoil', 'unlimitedHolofoil', 'unlimited-holofoil'],
  reverse: ['reverse-holofoil', 'reverseHolofoil'],
  firstEdition: ['1stEditionHolofoil', '1st-edition-holofoil', '1stEditionNormal', '1st-edition-normal', '1stEdition'],
};

/** Price of one copy for a variant from one source, or null when that source has no price. */
export function priceOf(card, variant, source) {
  const p = card?.pricing || {};
  if (source === 'tcgplayer') {
    const t = p.tcgplayer;
    if (!t) return null;
    const keys = Object.keys(t).filter((k) => t[k] && typeof t[k] === 'object');
    const k = (TCGP_KEYS[variant] || []).find((x) => t[x]) ?? keys[0];
    if (!k) return null;
    const r = t[k];
    const value = pos(r.marketPrice) ?? pos(r.midPrice) ?? pos(r.lowPrice);
    if (value == null) return null;
    return {
      source, currency: t.unit || 'USD', value, updated: t.updated, exact: (TCGP_KEYS[variant] || []).includes(k),
      rows: [['Market', pos(r.marketPrice)], ['Low', pos(r.lowPrice)], ['Mid', pos(r.midPrice)]],
      productId: r.productId ?? null,
    };
  }
  const m = p.cardmarket;
  if (!m) return null;
  // Cardmarket's price guide keeps reverse holos in the "-holo" fields.
  const read = (sfx) => ({
    trend: pos(m['trend' + sfx]), avg30: pos(m['avg30' + sfx]), avg7: pos(m['avg7' + sfx]),
    avg: pos(m['avg' + sfx]), low: pos(m['low' + sfx]),
  });
  let f = read(variant === 'reverse' ? '-holo' : '');
  let exact = true;
  if (f.trend == null && f.avg30 == null && f.avg == null) { f = read(''); exact = variant !== 'reverse'; }
  const value = f.trend ?? f.avg30 ?? f.avg7 ?? f.avg;
  if (value == null) return null;
  return {
    source, currency: m.unit || 'EUR', value, updated: m.updated, exact,
    rows: [['Trend', f.trend], ['30-day avg', f.avg30], ['From', f.low]],
    productId: m.idProduct ?? null,
  };
}

export function pricesFor(card, variant) {
  const snap = (s) => { const p = priceOf(card, variant, s); return p ? { v: p.value, c: p.currency } : null; };
  return { cardmarket: snap('cardmarket'), tcgplayer: snap('tcgplayer') };
}

export function marketLinks(card, brief) {
  const name = card?.name || brief?.name || '';
  const num = card?.localId || brief?.localId || '';
  const setName = card?.set?.name || brief?.set?.name || '';
  const tp = card?.pricing?.tcgplayer;
  const tpId = tp && Object.values(tp).find((x) => x && typeof x === 'object' && x.productId)?.productId;
  return {
    cardmarket: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(`${name} ${setName}`.trim())}`,
    tcgplayer: tpId
      ? `https://www.tcgplayer.com/product/${tpId}`
      : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(`${name} ${num}`.trim())}`,
  };
}

// ---------- backup prices ----------

const hasPrice = (card) => ['cardmarket', 'tcgplayer'].some((s) => ['normal', 'holo', 'reverse', 'firstEdition'].some((v) => priceOf(card, v, s)));

let backupP = null;
const simple = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * When TCGdex has no price (often the newest sets), look the card up in the TCGplayer price file
 * that ships with the site (data/tcgplayer-prices.json, built by scripts/update-backup-prices.mjs).
 * It is only downloaded the first time a card without a TCGdex price shows up.
 */
async function withBackupPrices(card) {
  if (hasPrice(card)) return card;
  try {
    backupP ??= fetch('data/tcgplayer-prices.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const data = await backupP;
    if (!data) return card;
    const want = simple(card.set?.name);
    const keys = Object.keys(data.sets);
    // set names differ a little between TCGdex and TCGplayer ("SV06: Twilight Masquerade")
    const key = keys.find((k) => k === want) || keys.find((k) => k.endsWith(' ' + want) || k.endsWith(want))
      || keys.find((k) => k.includes(want)) || keys.find((k) => k.length > 5 && want.includes(k));
    const list = key && data.sets[key][normNum(card.localId)];
    if (!list) return card;
    const name = simple(card.name);
    const [, pr] = list.find(([n]) => n.startsWith(name)) || list.find(([n]) => n.includes(name.split(' ')[0])) || list[0];
    const tcgplayer = { unit: data.unit, updated: data.updated, source: 'backup' };
    for (const [k, v] of Object.entries(pr)) tcgplayer[k] = { marketPrice: v };
    card.pricing = { ...(card.pricing || {}), tcgplayer };
  } catch { /* keep the card without a price */ }
  return card;
}

/** Price in the chosen source, or else the other source (so a card never looks priceless needlessly). */
export function bestPrice(card, variant, source) {
  return priceOf(card, variant, source) ?? priceOf(card, variant, source === 'cardmarket' ? 'tcgplayer' : 'cardmarket');
}
