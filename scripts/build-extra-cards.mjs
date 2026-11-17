// Builds site/data/extra-cards.json: a second card source next to TCGdex, from the open
// Pokémon TCG data set (https://github.com/PokemonTCG/pokemon-tcg-data). It adds
//  - images and rarity for TCGdex cards that have none (so they can be compared with the photo),
//  - set codes (BS, SVI, PAF…) and release dates for every set it can match,
//  - cards that TCGdex does not have at all, so they can be scanned too.
// Run on your own computer before a deploy:
//
//   node scripts/build-extra-cards.mjs && npx wrangler deploy

import { writeFile } from 'node:fs/promises';

const RAW = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const UA = { 'user-agent': 'Schatkaart card index (+https://schatkaart.julietous.workers.dev)' };
const simple = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const num = (s) => String(s || '').toUpperCase().split('/')[0].replace(/\s+/g, '').replace(/(^|[A-Z])0+(?=\d)/g, '$1');

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error('failed ' + url);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

const [ptSets, dxCards, dxSets] = await Promise.all([get(`${RAW}/sets/en.json`), get(`${TCGDEX}/cards`), get(`${TCGDEX}/sets`)]);

// TCGdex set details carry the online code and release date, used to pair the two sources.
const dxDetail = new Map();
await pool(dxSets, 8, async (s) => { try { dxDetail.set(s.id, await get(`${TCGDEX}/sets/${encodeURIComponent(s.id)}`)); } catch { /* skip */ } });

const dxBySet = new Map();
for (const c of dxCards) {
  const setId = c.id.slice(0, c.id.lastIndexOf('-'));
  if (!dxBySet.has(setId)) dxBySet.set(setId, new Map());
  dxBySet.get(setId).set(num(decodeURIComponent(c.localId)), c);
}

function pairSet(p) {
  const date = p.releaseDate?.replace(/\//g, '-');
  let best = null; let bestScore = 0;
  for (const d of dxDetail.values()) {
    let s = 0;
    if (p.ptcgoCode && d.tcgOnline && p.ptcgoCode === d.tcgOnline) s += 3;
    if (date && d.releaseDate === date) s += 2;
    if (simple(d.name) === simple(p.name)) s += 3;
    else if (simple(d.name).includes(simple(p.name)) || simple(p.name).includes(simple(d.name))) s += 1;
    if (d.cardCount?.official === p.printedTotal) s += 1;
    if (s > bestScore) { bestScore = s; best = d; }
  }
  return bestScore >= 4 ? best : null;
}

const out = { v: 1, source: 'Pokémon TCG data set', updated: new Date().toISOString(), sets: {}, more: {}, cards: [] };
let enriched = 0;
await pool(ptSets, 6, async (p) => {
  let cards;
  try { cards = await get(`${RAW}/cards/en/${p.id}.json`); } catch { console.warn('skipped', p.id); return; }
  const d = pairSet(p);
  const key = d ? d.id : 'ptcg-' + p.id;
  out.sets[key] = {
    name: d?.name || p.name, code: p.ptcgoCode || d?.abbreviation?.official || null,
    series: p.series, released: p.releaseDate?.replace(/\//g, '-') || d?.releaseDate || null,
    official: p.printedTotal, total: p.total, tcgdex: !!d,
  };
  const dx = d ? dxBySet.get(d.id) || new Map() : new Map();
  for (const c of cards) {
    const hit = dx.get(num(c.number));
    if (hit && simple(hit.name).split(' ')[0] === simple(c.name).split(' ')[0]) {
      out.more[hit.id] = [hit.image ? null : c.images?.small || null, c.rarity || null];
      enriched++;
    } else if (!hit) {
      out.cards.push([key, c.number, c.name, c.images?.small || null, c.rarity || null]);
    }
  }
});
for (const [id, d] of dxDetail) {
  if (out.sets[id]) continue;
  out.sets[id] = { name: d.name, code: d.abbreviation?.official || d.tcgOnline || null, series: d.serie?.name || null, released: d.releaseDate || null, tcgdex: true };
}
await writeFile(new URL('../site/data/extra-cards.json', import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(out.sets).length} sets, ${enriched} TCGdex cards enriched, ${out.cards.length} extra cards`);
