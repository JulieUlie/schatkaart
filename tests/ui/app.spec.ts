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
    // The round magnifier under the viewfinder. The text button on the start screen gets covered by the
    // "Added to your pile" panel after the first card, so a user taps the magnifier, and so do we.
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
});
