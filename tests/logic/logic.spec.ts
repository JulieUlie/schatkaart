import { test as base, expect } from '@playwright/test';
import { mockTcgdex, DETAILS } from '../support/tcgdex';

/**
 * The app's own ES modules, loaded straight into the browser and called like functions.
 * No interface involved, so these are fast, exact tests of the logic.
 * The page is a plain file from the app (its icon), so app.js itself never starts.
 */
const test = base.extend<{ mod: <T = any>(path: string, fn: string, ...args: unknown[]) => Promise<T> }>({
  mod: async ({ page }, use) => {
    await mockTcgdex(page);
    await page.goto('/icon.svg');
    await use((path, fn, ...args) =>
      page.evaluate(async ([p, f, a]) => (await import(p as string))[f as string](...(a as unknown[])), [path, fn, args] as const),
    );
  },
});

test.describe('Text helpers (util.js)', () => {
  test('norm() lowercases, strips accents and punctuation', async ({ mod }) => {
    expect(await mod('/js/util.js', 'norm', "Flabébé's  Pokémon-ex!")).toBe('flabebes pokemon ex');
  });

  for (const [input, out] of [['025', '25'], ['SV049', 'SV49'], ['TG05', 'TG5'], ['swsh050', 'SWSH50'], ['0', '0']]) {
    test(`normNum("${input}") is "${out}"`, async ({ mod }) => {
      expect(await mod('/js/util.js', 'normNum', input)).toBe(out);
    });
  }

  test('lev() counts edits, sim() turns it into 0..1', async ({ mod }) => {
    expect(await mod('/js/util.js', 'lev', 'charizard', 'charzard')).toBe(1);
    expect(await mod('/js/util.js', 'sim', 'pikachu', 'pikachu')).toBe(1);
    expect(await mod<number>('/js/util.js', 'sim', 'charizard', 'charzard')).toBeGreaterThan(0.85);
  });

  test('money() shows two decimals and a dash for "no price"', async ({ mod }) => {
    expect(await mod('/js/util.js', 'money', 327.41, 'EUR')).toBe('€327.41');
    expect(await mod('/js/util.js', 'money', 0.5, 'USD')).toBe('US$0.50');
    expect(await mod('/js/util.js', 'money', null)).toBe('—');
  });

  test('esc() neutralises HTML', async ({ mod }) => {
    expect(await mod('/js/util.js', 'esc', `<img src=x onerror="alert('x')">`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;');
  });
});

test.describe('Reading card numbers from OCR text (recognize.js)', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['a normal number', 'Furret  136/189  ©2020', { nums: ['136'], totalNum: 189 }],
    ['spaces around the slash', '58 / 102', { nums: ['58'], totalNum: 102 }],
  ];

  test('finds a trainer gallery number: "TG05/TG30"', async ({ mod }) => {
    const [hit] = await mod<any[]>('/js/recognize.js', 'parseNumbers', 'TG05/TG30');
    // The parser also tries "G read as 6" (605), which matching drops later because no card has it.
    expect(hit.nums).toContain('TG5');
    // Only the presence of a text total matters for scoring, not its exact spelling ("T630" today).
    expect(hit.totalNum).toBeNull();
    expect(hit.totalStr).toBeTruthy();
  });
  for (const [title, text, want] of cases) {
    test(`finds ${title}: "${text}"`, async ({ mod }) => {
      const found = await mod<any[]>('/js/recognize.js', 'parseNumbers', text);
      expect(found[0]).toMatchObject(want);
    });
  }

  test('a slash misread as 1 or 7 is still found, as a guess', async ({ mod }) => {
    const found = await mod<any[]>('/js/recognize.js', 'parseNumbers', '2381191');
    expect(found).toContainEqual(expect.objectContaining({ nums: ['238'], totalNum: 191, guess: true }));
  });

  test('ignores text without numbers', async ({ mod }) => {
    expect(await mod('/js/recognize.js', 'parseNumbers', 'HP/ATK')).toEqual([]);
  });
});

test.describe('Search (catalog.js)', () => {
  const search = (page: import('@playwright/test').Page, q: string) =>
    page.evaluate(async (query) => {
      const c = await import('/js/catalog.js');
      const cat = await c.loadCatalog('en', { force: true });
      return c.search(cat, query).map((x: { id: string }) => x.id);
    }, q);

  test('finds a card by name, exact name first', async ({ mod, page }) => {
    expect(await search(page, 'charizard')).toEqual(['base1-4', 'swsh3-20']);
  });

  test('finds a card by its number and set size', async ({ mod, page }) => {
    expect(await search(page, '136/189')).toEqual(['swsh3-136']);
  });

  test('a leading zero in the number does not matter', async ({ mod, page }) => {
    expect(await search(page, 'Charizard 020')).toEqual(['swsh3-20']);
  });

  test('tolerates a typo', async ({ mod, page }) => {
    expect(await search(page, 'Charzard')).toContain('base1-4');
  });

  test('leaves out Pokémon TCG Pocket cards (digital only), from both sources', async ({ mod, page }) => {
    expect(await search(page, 'bulbasaur')).toEqual([]);
    expect(await search(page, 'ivysaur')).toEqual([]);
  });

  test('adds cards from the second source that TCGdex lacks, with an "x:" id', async ({ mod, page }) => {
    expect(await search(page, 'pikachu')).toEqual(['x:xtra-promo-7', 'base1-58']); // newer set first
  });
});

test.describe('Prices (catalog.js)', () => {
  const price = (page: import('@playwright/test').Page, id: string, variant: string, source: string, fn = 'priceOf') =>
    page.evaluate(async ([card, v, s, f]) => (await import('/js/catalog.js'))[f](card, v, s), [DETAILS[id], variant, source, fn] as const);

  test('Cardmarket uses the trend price', async ({ mod, page }) => {
    expect(await price(page, 'base1-4', 'holo', 'cardmarket')).toMatchObject({ value: 327.41, currency: 'EUR', exact: true });
  });

  test('TCGplayer uses the market price of the right variant', async ({ mod, page }) => {
    expect(await price(page, 'base1-4', 'holo', 'tcgplayer')).toMatchObject({ value: 1001.05, currency: 'USD', productId: 42382 });
  });

  test('a reverse holo reads Cardmarket\'s "-holo" fields', async ({ mod, page }) => {
    expect(await price(page, 'swsh3-136', 'reverse', 'cardmarket')).toMatchObject({ value: 0.28, exact: true });
  });

  test('no price is null, and bestPrice falls back to the other source', async ({ mod, page }) => {
    expect(await price(page, 'base1-2', 'holo', 'cardmarket')).toBeNull();
    expect(await price(page, 'swsh3-20', 'holo', 'cardmarket', 'bestPrice')).toMatchObject({ value: 40, source: 'tcgplayer' });
  });

  test('variantsOf lists only the variants that exist', async ({ mod }) => {
    expect(await mod('/js/catalog.js', 'variantsOf', DETAILS['base1-4'])).toEqual(['holo', 'firstEdition']);
    expect(await mod('/js/catalog.js', 'variantsOf', {})).toEqual(['normal']);
  });
});

test.describe('Sync codes and merging (sync.js)', () => {
  test('a new code is 4 groups of 5, without look-alike characters', async ({ mod }) => {
    for (let i = 0; i < 20; i++) {
      const code = await mod<string>('/js/sync.js', 'newCode');
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    }
  });

  test('cleanCode accepts sloppy typing and refuses wrong codes', async ({ mod }) => {
    expect(await mod('/js/sync.js', 'cleanCode', ' abcde fghjk-mnpqr  stuvw ')).toBe('ABCDE-FGHJK-MNPQR-STUVW');
    expect(await mod('/js/sync.js', 'cleanCode', 'ABCDE-FGHJK-MNPQR-STUV')).toBeNull(); // 19 characters
    expect(await mod('/js/sync.js', 'cleanCode', 'ABCDE-FGHJK-MNPQR-STUV0')).toBeNull(); // 0 is never used
  });

  test('merging keeps the newest version of each card', async ({ mod }) => {
    const phone = [{ id: 'a', qty: 1, updatedAt: 10 }, { id: 'b', qty: 1, updatedAt: 30 }];
    const laptop = [{ id: 'a', qty: 3, updatedAt: 20 }, { id: 'c', qty: 1, updatedAt: 5 }];

    const merged = await mod<any[]>('/js/sync.js', 'mergeItems', phone, laptop);

    expect(merged.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'a', qty: 3, updatedAt: 20 }, { id: 'b', qty: 1, updatedAt: 30 }, { id: 'c', qty: 1, updatedAt: 5 },
    ]);
  });
});

test.describe('End-to-end encrypted sync (sync.js + the local Worker)', () => {
  test('two devices with the same code end up with the same collection', async ({ mod, page, browser }) => {
    const code = await mod<string>('/js/sync.js', 'newCode');
    const phoneItems = [{ id: 'p1', name: 'Charizard', qty: 1, updatedAt: 1, profile: 'me' }];

    const first = await mod<any>('/js/sync.js', 'syncItems', code, phoneItems);
    expect(first.items).toHaveLength(1);

    // a second "device": a fresh browser context, so nothing is shared but the code
    const laptop = await (await browser.newContext()).newPage();
    await laptop.goto('/icon.svg');
    const second = await laptop.evaluate(async ([c]) => {
      const s = await import('/js/sync.js');
      return s.syncItems(c, [{ id: 'l1', name: 'Pikachu', qty: 2, updatedAt: 2, profile: 'me' }]);
    }, [code]);

    expect(second.items.map((i: { id: string }) => i.id).sort()).toEqual(['l1', 'p1']);
    expect(second.changedLocal).toBe(true);
    await laptop.context().close();
  });

  test('the server only ever receives ciphertext, never card names or the code', async ({ mod, page }) => {
    const sent: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/sync/')) sent.push(r.url() + ' ' + (r.postData() ?? '')); });
    const code = await mod<string>('/js/sync.js', 'newCode');

    await mod('/js/sync.js', 'syncItems', code, [{ id: 'x', name: 'Secret Charizard', qty: 1, updatedAt: 1 }]);

    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s).not.toContain('Charizard');
      expect(s).not.toContain(code.replace(/-/g, ''));
    }
  });

  test('a deleted online copy is gone for the other device too', async ({ mod }) => {
    const code = await mod<string>('/js/sync.js', 'newCode');
    await mod('/js/sync.js', 'syncItems', code, [{ id: 'x', qty: 1, updatedAt: 1 }]);

    await mod('/js/sync.js', 'deleteRemote', code);
    const after = await mod<any>('/js/sync.js', 'syncItems', code, []);

    expect(after.items).toEqual([]);
  });
});
