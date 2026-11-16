// Builds site/data/tcgplayer-prices.json: TCGplayer market prices for every Pokémon set, from
// TCGCSV (https://tcgcsv.com, a free daily dump). The app only uses it when TCGdex has no price
// for a card, which mostly happens for the newest sets. TCGCSV refuses requests from Cloudflare
// Workers, so this runs on your own computer before a deploy:
//
//   node scripts/update-backup-prices.mjs && npx wrangler deploy

import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://tcgcsv.com/tcgplayer/3'; // 3 = Pokémon
const UA = { 'user-agent': 'Schatkaart price backup (+https://schatkaart.julietous.workers.dev)' };
const simple = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const num = (s) => String(s || '').toUpperCase().split('/')[0].replace(/\s+/g, '').replace(/(^|[A-Z])0+(?=\d)/g, '$1');
const KEY = {
  'Normal': 'normal', 'Holofoil': 'holofoil', 'Reverse Holofoil': 'reverse-holofoil',
  '1st Edition Holofoil': '1stEditionHolofoil', '1st Edition': '1stEditionNormal', '1st Edition Normal': '1stEditionNormal',
  'Unlimited Holofoil': 'unlimitedHolofoil', 'Unlimited': 'unlimitedNormal',
};

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: UA });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error('failed ' + url);
}

const groups = (await get(`${BASE}/groups`)).results;
const sets = {};
let cards = 0;
let i = 0;
async function worker() {
  while (i < groups.length) {
    const g = groups[i++];
    try {
      const [products, prices] = await Promise.all([get(`${BASE}/${g.groupId}/products`), get(`${BASE}/${g.groupId}/prices`)]);
      const byId = new Map();
      for (const p of prices.results || []) {
        const v = p.marketPrice ?? p.midPrice ?? p.lowPrice;
        if (v == null) continue;
        if (!byId.has(p.productId)) byId.set(p.productId, {});
        byId.get(p.productId)[KEY[p.subTypeName] || simple(p.subTypeName).replace(/ /g, '-')] = Math.round(v * 100) / 100;
      }
      const set = {};
      for (const p of products.results || []) {
        const n = num(p.extendedData?.find((e) => e.name === 'Number')?.value);
        const pr = byId.get(p.productId);
        if (!n || !pr) continue;
        (set[n] ||= []).push([simple(p.name), pr]);
        cards++;
      }
      if (Object.keys(set).length) sets[simple(g.name)] = set;
    } catch (e) {
      console.warn('skipped', g.name, e.message);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

await mkdir(new URL('../site/data/', import.meta.url), { recursive: true });
const out = { source: 'TCGplayer via TCGCSV', unit: 'USD', updated: new Date().toISOString(), sets };
await writeFile(new URL('../site/data/tcgplayer-prices.json', import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(sets).length} sets, ${cards} cards written`);
