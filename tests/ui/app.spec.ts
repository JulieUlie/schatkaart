import { test as base, expect, Page, Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockTcgdex } from '../support/tcgdex';

/** Page object for Schatkaart. */
class Schatkaart {
  readonly pileTotal: Locator;
  readonly pileTitle: Locator;
  readonly pile: Locator;
  readonly sheet: Locator;
  readonly searchDialog: Locator;
  readonly toasts: Locator;

  constructor(readonly page: Page) {
    this.pileTotal = page.locator('#pileTotal');
    this.pileTitle = page.locator('#pileTitle');
    this.pile = page.locator('#pileList');
    this.sheet = page.getByRole('dialog', { name: 'Card' });
    this.searchDialog = page.getByRole('dialog', { name: 'Find a card' });
    this.toasts = page.locator('#toasts');
  }

  /** A first visit opens the welcome window ("Who's collecting?"); answer it like a new visitor would. */
  async goto({ name = 'Tester' } = {}) {
    await this.page.goto('/');
    const welcome = this.page.getByRole('dialog', { name: 'Profile' });
    await expect(welcome.getByRole('heading', { name: "Hi! I'm Schatje." })).toBeVisible();
    await welcome.getByRole('textbox', { name: 'Name' }).fill(name);
    await welcome.getByRole('button', { name: "Let's go!" }).click();
    await expect(welcome).toBeHidden();
    await expect(this.page.getByRole('heading', { name: 'Ready to hunt for treasure?' })).toBeVisible();
  }

  async find(query: string) {
    // The round magnifier under the viewfinder, always in the same place. (Up to v3 the text button on the
    // start screen was covered by the "Added to your pile" panel after the first card; see the v4 tests.)
    await this.page.locator('.controls').getByRole('button', { name: 'Search by name' }).click();
    await expect(this.searchDialog).toBeVisible();
    await this.searchDialog.getByRole('searchbox').fill(query);
  }

  result(name: string, setAndNumber: string): Locator {
    return this.searchDialog.locator('#searchResults button').filter({ hasText: name }).filter({ hasText: setAndNumber });
  }

  /** Search, pick the card, confirm "Yes! Add to …" and close the sheet. */
  async add(query: string, name: string, setAndNumber: string, target: 'pile' | 'collection' = 'pile') {
    await this.find(query);
    await this.result(name, setAndNumber).click();
    await expect(this.sheet.getByRole('heading', { name: 'Is this your card?' })).toBeVisible();
    await this.sheet.getByRole('button', { name: target === 'pile' ? 'Yes! Add to pile' : 'Add to collection' }).click();
    await expect(this.sheet.getByRole('heading', { name: 'Got it!' })).toBeVisible();
    await this.sheet.getByRole('button', { name: 'Done' }).click();
    await expect(this.sheet).toBeHidden();
  }

  async tab(name: 'Scan' | 'Collection' | 'Settings') {
    await this.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(name) }).click();
  }
}

const test = base.extend<{ app: Schatkaart; tcgdex: string[] }>({
  tcgdex: async ({ page }, use) => use(await mockTcgdex(page)),
  app: async ({ page, tcgdex }, use) => {
    void tcgdex; // make sure the fake TCGdex is in place before the page loads
    const app = new Schatkaart(page);
    await app.goto();
    await use(app);
  },
});

test.describe('First visit', () => {
  test('the welcome window asks who is collecting, then shows that name @mobile', async ({ page, tcgdex }) => {
    void tcgdex;
    const app = new Schatkaart(page);

    await app.goto({ name: 'Julie' });

    await expect(page.getByRole('button', { name: 'Switch profile' })).toContainText('Julie');
  });

  test('the welcome window does not come back after a reload', async ({ app, page }) => {
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Ready to hunt for treasure?' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Profile' })).toBeHidden();
  });
});

test.describe('Search', () => {
  test('finds a card by name and shows set and number @mobile', async ({ app }) => {
    await app.find('Charizard');

    await expect(app.result('Charizard', 'Base Set · 4/102')).toBeVisible();
    await expect(app.result('Charizard VMAX', 'Darkness Ablaze · 020/189')).toBeVisible();
  });

  test('finds a card by its collector number', async ({ app }) => {
    await app.find('136/189');

    await expect(app.searchDialog.locator('#searchResults button')).toHaveCount(1);
    await expect(app.result('Furret', 'Darkness Ablaze')).toBeVisible();
  });

  test('says so when nothing matches', async ({ app }) => {
    await app.find('Mewtwo');

    await expect(app.searchDialog).toContainText('No cards found. Check the spelling, or try just the name.');
  });

  test('never shows digital Pokémon TCG Pocket cards', async ({ app }) => {
    await app.find('Bulbasaur');

    await expect(app.searchDialog).toContainText('No cards found');
  });
});

test.describe('The pile', () => {
  test('a card on the pile shows its price in the total @mobile', async ({ app }) => {
    await app.add('Charizard', 'Charizard', 'Base Set');

    await expect(app.pileTotal).toHaveText('€327.41');
    await expect(app.pileTitle).toHaveText('Pile · 1 card');
    await expect(app.pile).toContainText('Charizard');
    await expect(app.pile).toContainText('Holo'); // its first variant
  });

  test('the total adds up every card', async ({ app }) => {
    await app.add('Charizard', 'Charizard', 'Base Set');
    await app.add('Pikachu', 'Pikachu', 'Base Set');

    await expect(app.pileTotal).toHaveText('€329.91'); // 327.41 + 2.50
    await expect(app.pileTitle).toHaveText('Pile · 2 cards');
  });

  test('a card without a price is counted, not hidden', async ({ app }) => {
    await app.add('Blastoise', 'Blastoise', 'Base Set');

    await expect(app.pileTitle).toHaveText('Pile · 1 card (1 without price)');
    await expect(app.pileTotal).toHaveText('€0.00');
  });

  test('taking a card off can be undone', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set');

    await page.getByRole('button', { name: 'Take Pikachu off the pile' }).click();
    await expect(app.pileTitle).toHaveText('Pile');
    await app.toasts.locator('.toast', { hasText: 'Pikachu taken off the pile' }).getByRole('button', { name: 'Undo' }).click();

    await expect(app.pileTitle).toHaveText('Pile · 1 card');
  });

  test('the pile survives a reload', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set');

    await page.reload();

    await expect(app.pileTotal).toHaveText('€2.50');
  });

  test('switching to TCGplayer shows dollar prices', async ({ app }) => {
    await app.add('Charizard', 'Charizard', 'Base Set');

    await app.tab('Settings');
    await app.page.getByRole('radio', { name: 'TCGplayer ($)' }).click();
    await expect(app.page.getByRole('radio', { name: 'TCGplayer ($)' })).toHaveAttribute('aria-checked', 'true');
    await app.tab('Scan');

    await expect(app.pileTotal).toHaveText('US$1,001.05');
  });
});

test.describe('The collection', () => {
  test('"Add all to collection" moves the pile into the collection', async ({ app, page }) => {
    await app.add('Charizard', 'Charizard', 'Base Set');
    await app.add('Pikachu', 'Pikachu', 'Base Set');

    await page.getByRole('button', { name: 'Add all to collection' }).click();

    await expect(app.toasts).toContainText('2 cards added to your collection');
    await expect(app.pileTitle).toHaveText('Pile');
    await app.tab('Collection');
    await expect(page.locator('#collGrid .tile')).toHaveCount(2);
    await expect(page.locator('#stats')).toContainText('€329.91');
  });

  test('the same card twice becomes one tile with ×2', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set', 'collection');
    await app.add('Pikachu', 'Pikachu', 'Base Set', 'collection');

    await app.tab('Collection');

    await expect(page.locator('#collGrid .tile')).toHaveCount(1);
    await expect(page.locator('#collGrid .tile .qty')).toHaveText('×2');
    await expect(page.locator('#stats')).toContainText('€5.00');
  });

  test('export to JSON and import it again on another device', async ({ app, page, browser }) => {
    await app.add('Charizard', 'Charizard', 'Base Set', 'collection');
    await app.tab('Settings');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export (.json)' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^schatkaart-.+\.json$/);
    const path = await file.path();

    // a second device: a fresh browser context with an empty collection
    const other = await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' });
    const page2 = await other.newPage();
    await mockTcgdex(page2);
    const app2 = new Schatkaart(page2);
    await app2.goto();
    await app2.tab('Settings');
    const chooser = page2.waitForEvent('filechooser');
    await page2.getByRole('button', { name: /Import/ }).click();
    await (await chooser).setFiles(path);

    await expect(app2.toasts).toContainText('Imported 1 card');
    await app2.tab('Collection');
    await expect(page2.locator('#collGrid .tile')).toContainText('Charizard');
    await other.close();
  });

  test('the CSV export has a header row and one row per card', async ({ app, page }) => {
    await app.add('Furret', 'Furret', 'Darkness Ablaze', 'collection');
    await app.tab('Settings');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export for spreadsheets (.csv)' }).click();
    const csv = (await import('node:fs')).readFileSync(await (await download).path(), 'utf8').replace(/^﻿/, '');

    const rows = csv.trim().split(/\r?\n/);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Furret');
  });

  test('a file that is not a backup is refused', async ({ app, page }) => {
    await app.tab('Settings');

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Import/ }).click();
    await (await chooser).setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });

    await expect(app.toasts).toContainText("That file isn't a Schatkaart backup.");
  });
});

test.describe('Camera and accessibility', () => {
  test("“Take a photo” opens the phone's camera through the photo picker @mobile", async ({ app, page }) => {
    const chooser = page.waitForEvent('filechooser');

    await page.getByRole('button', { name: 'Take a photo', exact: true }).click();

    const picker = await chooser;
    expect(picker.isMultiple()).toBe(false);
    await expect(page.locator('#fileInput')).toHaveAttribute('accept', 'image/*');
    await expect(page.locator('#fileInput')).toHaveAttribute('capture', 'environment');
  });

  // Headless browsers answer a camera request differently, so the answer is simulated: the test is
  // about what the app tells the user, not about the browser.
  for (const [error, text] of [
    ['NotAllowedError', /allow|permission|access/i],
    ['NotFoundError', 'No camera found on this device. You can pick a photo instead.'],
  ] as const) {
    test(`explains what to do when the camera answers ${error}`, async ({ page, tcgdex }) => {
      void tcgdex;
      await page.addInitScript((name) => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('simulated', name));
      }, error);
      const app = new Schatkaart(page);
      await app.goto();

      // the live camera only starts for Auto scan; "Take a photo" uses the phone's own camera app
      await page.getByRole('button', { name: 'Auto scan' }).click();

      await expect(page.locator('#camError')).toBeVisible();
      await expect(page.locator('#camError')).toHaveText(text);
    });
  }

  test('the scan screen has no detectable WCAG violations', async ({ app, page }) => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
  });

  test('the scan screen with a card on the pile has no detectable WCAG violations', async ({ app, page }) => {
    await app.add('Charizard', 'Charizard VMAX', 'Darkness Ablaze');

    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
  });
});

// Regression tests for the v4 refinements (23 Nov 2026).
test.describe('v4: layout', () => {
  test('a card on the pile never makes the page scroll sideways @mobile', async ({ app, page }) => {
    await app.add('Charizard', 'Charizard VMAX', 'Darkness Ablaze');

    // v3: the pile row's text did not shrink, so the whole scan page grew wider than the phone
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
    // name and set sit on two lines (v3 glued them together: "Charizard VMAXDarkness Ablaze")
    const name = await app.pile.locator('.name').first().boundingBox();
    const meta = await app.pile.locator('.meta').first().boundingBox();
    expect(meta!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
  });

  test('the start-screen buttons stay usable once a card was found @mobile', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set');
    await expect(page.locator('#mini')).toBeVisible();

    // v3: the "Added to your pile" panel covered these buttons; a click on them now really lands
    const start = page.locator('#vfIdle');
    await start.getByRole('button', { name: 'Search by name' }).click();
    await expect(app.searchDialog).toBeVisible();
    await app.searchDialog.getByRole('button', { name: 'Close' }).click();
    const chooser = page.waitForEvent('filechooser');
    await start.getByRole('button', { name: 'Take a photo', exact: true }).click();
    await chooser;
  });

  test('on a wide screen a message does not cover the tab bar', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set');

    // the first message of a stack sits closest to the edge (v3: top centre, right over the header's tab bar)
    const toast = await app.toasts.locator('.toast', { hasText: 'Pikachu added to your pile' }).boundingBox();
    const tabs = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
    const overlap = toast!.x < tabs!.x + tabs!.width && tabs!.x < toast!.x + toast!.width
      && toast!.y < tabs!.y + tabs!.height && tabs!.y < toast!.y + toast!.height;
    expect(overlap).toBe(false);
  });
});

test.describe('v4: prices from the other market', () => {
  // Charizard VMAX only has a TCGplayer (dollar) price in the fake TCGdex.
  test('the pile shows that price in dollars and keeps it out of the euro total', async ({ app }) => {
    await app.add('Charizard', 'Charizard VMAX', 'Darkness Ablaze');

    await expect(app.pile.locator('.sticker')).toHaveText('US$40.00'); // v3 showed "€40.00"
    await expect(app.pileTotal).toHaveText('€0.00'); // v3 added the dollars to the euro total
    await expect(app.pileTitle).toHaveText('Pile · 1 card (1 only on TCGplayer)');
  });

  test('the collection worth counts only euro prices and says what it left out', async ({ app, page }) => {
    await app.add('Charizard', 'Charizard VMAX', 'Darkness Ablaze', 'collection');
    await app.add('Pikachu', 'Pikachu', 'Base Set', 'collection');

    await app.tab('Collection');

    await expect(page.locator('#stats')).toContainText('€2.50');
    await expect(page.locator('#stats')).toContainText("1 card only has a TCGplayer price, so it isn't in the worth.");
    await expect(page.locator('#collGrid .tile', { hasText: 'Charizard VMAX' }).locator('.sticker')).toHaveText('US$40.00');
  });

  test('with TCGplayer chosen, the same card counts in the dollar total', async ({ app }) => {
    await app.add('Charizard', 'Charizard VMAX', 'Darkness Ablaze');

    await app.tab('Settings');
    await app.page.getByRole('radio', { name: 'TCGplayer ($)' }).click();
    await app.tab('Scan');

    await expect(app.pileTotal).toHaveText('US$40.00');
    await expect(app.pileTitle).toHaveText('Pile · 1 card');
  });
});

test.describe('v4: keyboard and feedback', () => {
  test('"Found cards go to" works like a radio group: one Tab stop, arrow keys pick', async ({ app, page }) => {
    const group = page.getByRole('radiogroup', { name: 'Found cards go to' });
    const pile = group.getByRole('radio', { name: 'Pile' });
    const collection = group.getByRole('radio', { name: 'Collection' });
    const nowhere = group.getByRole('radio', { name: 'Nowhere' });
    await expect(pile).toHaveAttribute('tabindex', '0');
    await expect(collection).toHaveAttribute('tabindex', '-1');

    await pile.focus();
    await page.keyboard.press('ArrowRight');
    await expect(collection).toBeFocused();
    await expect(collection).toHaveAttribute('aria-checked', 'true');
    await expect(collection).toHaveAttribute('tabindex', '0');
    await expect(pile).toHaveAttribute('tabindex', '-1');

    await page.keyboard.press('End');
    await expect(nowhere).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight'); // wraps around
    await expect(pile).toHaveAttribute('aria-checked', 'true');

    // the choice is remembered
    await page.reload();
    await expect(pile).toHaveAttribute('aria-checked', 'true');
  });

  test('the theme setting can be changed with the arrow keys', async ({ app, page }) => {
    await app.tab('Settings');
    const auto = page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Auto' });

    await auto.focus();
    await page.keyboard.press('ArrowRight');

    await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('"Refresh prices" says so when the price service is down, and can be tried again', async ({ app, page }) => {
    await app.add('Pikachu', 'Pikachu', 'Base Set', 'collection');
    await page.reload(); // empty the in-memory card cache, so a refresh really asks TCGdex
    await page.route('https://api.tcgdex.net/**', (r) => r.fulfill({ status: 503, body: 'down' }));
    await app.tab('Collection');

    const refresh = page.getByRole('button', { name: 'Refresh prices' });
    await refresh.click();

    await expect(app.toasts).toContainText("Couldn't reach the price service. Your old prices are kept.");
    await expect(refresh).toBeEnabled();
    await expect(page.locator('#stats')).toContainText('€2.50');
  });

  test('the search fields have a name a screen reader can say', async ({ app, page }) => {
    await app.tab('Collection');
    await expect(page.getByRole('searchbox', { name: 'Search your collection' })).toBeVisible();
    await app.tab('Scan');
    await app.find('Pikachu');
    await expect(app.searchDialog.getByRole('searchbox', { name: 'Card name or number' })).toBeVisible();
  });
});
