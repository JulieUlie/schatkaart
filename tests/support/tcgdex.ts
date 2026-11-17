import { readFileSync } from 'node:fs';
import type { Page, BrowserContext } from '@playwright/test';

/**
 * A small fake TCGdex (https://api.tcgdex.net), shaped like the real API. The two full card
 * details are real responses saved on 17 Nov 2026; the rest is made up but has the same fields.
 * Tests become predictable and fast, and do not depend on a third party being up.
 */
const real = (id: string) => JSON.parse(readFileSync(new URL(`../fixtures/tcgdex/${id}.json`, import.meta.url), 'utf8'));

const IMG = (path: string) => `https://assets.tcgdex.net/en/${path}`;

export const SETS = [
  { id: 'base1', name: 'Base Set', logo: IMG('base/base1/logo'), cardCount: { total: 102, official: 102 } },
  { id: 'swsh3', name: 'Darkness Ablaze', logo: IMG('swsh/swsh3/logo'), cardCount: { total: 201, official: 189 } },
  { id: 'A1', name: 'Genetic Apex', logo: IMG('tcgp/A1/logo'), cardCount: { total: 286, official: 226 } }, // Pokémon TCG Pocket: digital
];

export const CARDS = [
  { id: 'base1-2', localId: '2', name: 'Blastoise', image: IMG('base/base1/2') },
  { id: 'base1-4', localId: '4', name: 'Charizard', image: IMG('base/base1/4') },
  { id: 'base1-58', localId: '58', name: 'Pikachu', image: IMG('base/base1/58') },
  { id: 'swsh3-20', localId: '020', name: 'Charizard VMAX', image: IMG('swsh/swsh3/20') },
  { id: 'swsh3-136', localId: '136', name: 'Furret', image: IMG('swsh/swsh3/136') },
  { id: 'A1-1', localId: '001', name: 'Bulbasaur', image: IMG('tcgp/A1/1') }, // must never show up: Pocket set
];

const brief = (id: string) => {
  const c = CARDS.find((x) => x.id === id)!;
  const set = SETS.find((s) => id.startsWith(s.id + '-'))!;
  return { ...c, set: { id: set.id, name: set.name, logo: set.logo, cardCount: set.cardCount } };
};

export const DETAILS: Record<string, unknown> = {
  'base1-4': real('base1-4'), // Charizard: holo + 1st edition, Cardmarket trend €327.41, TCGplayer holo $1001.05
  'swsh3-136': real('swsh3-136'), // Furret: normal + reverse holo, cents
  'base1-58': { ...brief('base1-58'), variants: { normal: true }, pricing: { cardmarket: { unit: 'EUR', updated: '2026-11-16T00:00:00Z', trend: 2.5, avg30: 2.4 } } },
  'base1-2': { ...brief('base1-2'), variants: { holo: true }, pricing: {} }, // no price at all
  'swsh3-20': { ...brief('swsh3-20'), variants: { holo: true }, pricing: { tcgplayer: { unit: 'USD', updated: '2026-11-16T00:00:00Z', holofoil: { marketPrice: 40 } } } },
};

/** Fake second source: rarity for a TCGdex card, and one set + card that TCGdex does not have. */
export const EXTRA = {
  v: 1,
  source: 'Pokémon TCG data set',
  updated: '2026-11-17T00:00:00Z',
  sets: {
    base1: { name: 'Base Set', code: 'BS', series: 'Base', released: '1999-01-09', official: 102, total: 102, tcgdex: true },
    swsh3: { name: 'Darkness Ablaze', code: 'DAA', series: 'Sword & Shield', released: '2020-08-14', official: 189, total: 201, tcgdex: true },
    A1: { name: 'Genetic Apex', tcgdex: true }, // a TCGdex set left out on purpose: must stay out
    'xtra-promo': { name: 'Extra Promos', code: 'XP', series: 'Promo', released: '2021-03-01', official: 10, total: 10 },
  },
  more: { 'base1-2': [null, 'Rare Holo'] },
  cards: [
    ['xtra-promo', '7', 'Pikachu', 'https://images.pokemontcg.io/xtra-promo/7.png', 'Promo'],
    ['A1', '2', 'Ivysaur', 'https://images.pokemontcg.io/A1/2.png', 'Common'], // Pocket: must never be added
  ],
};

// 1×1 transparent PNG for every card image and logo
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export type TcgdexOptions = { down?: boolean };

/** Route all TCGdex traffic of a page (or a whole context) to the fake. Returns the URLs that were asked for. */
export async function mockTcgdex(target: Page | BrowserContext, { down = false }: TcgdexOptions = {}) {
  const asked: string[] = [];
  await target.route('https://assets.tcgdex.net/**', (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
  await target.route('https://api.tcgdex.net/**', (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    if (down) return route.fulfill({ status: 503, body: 'down' });
    const p = url.pathname.replace(/^\/v2\/[a-z]+/, '');
    if (p === '/cards') return route.fulfill({ json: CARDS.map(({ id, localId, name, image }) => ({ id, localId, name, image })) });
    if (p === '/sets') return route.fulfill({ json: SETS });
    if (p === '/series/tcgp') return route.fulfill({ json: { id: 'tcgp', name: 'Pokémon TCG Pocket', sets: [{ id: 'A1', name: 'Genetic Apex' }] } });
    const one = p.match(/^\/cards\/(.+)$/);
    if (one && DETAILS[one[1]]) return route.fulfill({ json: DETAILS[one[1]] });
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });
  await target.route('https://images.pokemontcg.io/**', (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
  // the bundled backup price file is a real 1 MB download; give the tests an empty one
  await target.route('**/data/tcgplayer-prices.json', (r) => r.fulfill({ json: { unit: 'USD', updated: '2026-11-16', sets: {} } }));
  // the second card source (Pokémon TCG data set), same format as site/data/extra-cards.json
  await target.route('**/data/extra-cards.json', (r) => r.fulfill({ json: EXTRA }));
  return asked;
}
