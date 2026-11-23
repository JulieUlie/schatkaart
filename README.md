# Schatkaart

**Live:** https://schatkaart.julietous.workers.dev

A cute, phone-first Pokémon card scanner. Point your camera at a card: a glowing outline snaps to the
card's edges, Schatje (a treasure chest with googly eyes) reads it, asks *"Is this your card?"*, and shows
every print with the same name so you can pick the exact set and number. Since v3 the prints are grouped per artwork (Art 1, Art 2…), each with its set code, number, year and type (secret rare, full art, illustration rare, promo…). Then it shows the price.

Made for yard sales (scan a stack onto the **pile** and see its total) and for sorting a **collection**.

## What's new in v4 (23 Nov 2026)

A polish release:

- **Honest totals across currencies.** When the chosen market has no price for a card, the other market's price is now shown in its own currency (a TCGplayer-only card shows `US$40.00`, not `€40.00`) and is kept out of the total, with a note such as *"1 only on TCGplayer"*. v3 put the dollar amount behind a euro sign and added it to the euro total.
- **No sideways scrolling on phones.** A card with a long set name no longer makes the scan page wider than the screen, and the pile shows the card name and its set on two lines instead of glued together.
- **Start screen stays usable after a find.** Once the "Added to your pile" card appears, the start screen gets compact so *Take a photo*, *Pick a photo* and *Search by name* stay visible and tappable above it.
- **Keyboard-friendly choices.** "Found cards go to", Theme and Prices work like real radio groups: one Tab stop, arrow keys and Home/End to pick.
- **Messages no longer cover the menu on wide screens.** Toasts sit at the bottom right on laptops (on phones they stay at the top, away from the bottom tab bar).
- **Clearer price refresh.** If the price service can't be reached, *Refresh prices* says so and keeps the old prices, and the button can never stay stuck on "Refreshing…".
- **Named search fields** for screen readers (collection search, card search, sync code).

## How it works

| Part | What it does |
| --- | --- |
| `site/js/detect.js` | Live card-edge detection: edge points along scanlines, a RANSAC line per side, four corners. Draws the outline and straightens the card (perspective warp) before reading. |
| `site/js/recognize.js` | Tesseract.js (in the browser) reads the collector number (`136/189`, `TG05/TG30`, `SWSH050`) and the name; both are matched against a local index of every card. The photo is compared with the official images to rank candidates and to mark reprints with the same art. |
| `site/js/catalog.js` | Card data from [TCGdex](https://tcgdex.dev): the full card list (≈24k English cards, cached in IndexedDB, refreshed every few days) plus card details with daily Cardmarket (EUR) and TCGplayer (USD) prices. Pokémon TCG Pocket (digital) sets are left out. |
| `site/data/extra-cards.json` | Second card source, built by `scripts/build-extra-cards.mjs` from the open [Pokémon TCG data set](https://github.com/PokemonTCG/pokemon-tcg-data): images and rarity for ~20k TCGdex cards (about 1,000 cards that had no picture now have one), set codes (BS, SVI…) and release dates, plus ~700 cards TCGdex lacks. |
| `site/js/db.js` | The collection lives in the visitor's own browser (IndexedDB). Several **profiles** can share one device, each with its own collection and pile. |
| `site/js/sync.js` + `src/worker.js` | Optional sync between someone's own devices with a random 20-character code. The collection is encrypted with AES-GCM in the browser; the Worker only stores the encrypted blob in KV under a hash of the code. No accounts and no sharing between people. |

## Tests

Playwright tests in TypeScript: `npm install`, then `npm test`. Playwright starts a local copy with `wrangler dev` and an empty local KV, so the sync tests never touch real sync data. Card data and prices from TCGdex, and the second card source, are faked in the browser tests (`tests/support/tcgdex.ts`, modelled on real TCGdex answers), so the tests are predictable and need no third party.

| Layer | Folder | What it covers |
| --- | --- | --- |
| Sync API | `tests/api/` | Storing and reading encrypted collections, revisions and conflicts between devices, what the server keeps, refused input, the 8 MB limit, delete |
| Logic | `tests/logic/` | The app's own modules in the browser: text helpers, reading card numbers from OCR text, search (numbers, typos, the second source, Pocket cards left out), prices per variant and source, sync codes, merging, and end-to-end encrypted sync where the server never sees a card name |
| Detector | `tests/logic/detect.spec.ts` | Card-edge detection on the real binder photo in `test/fixtures` (corner error must stay under 5% of the card width) |
| UI | `tests/ui/` | Welcome window, search, the pile and its total, undo, price source, collection, JSON/CSV export and import on a second device, camera errors, axe accessibility scans (empty and with a card found), and the v4 regressions: no sideways scroll, start-screen buttons not covered, toasts off the menu, prices from the other market in their own currency, radio groups by keyboard, a failed price refresh |

87 tests (v4 added 13), stable over repeated runs. Google Fonts are blocked in the browser tests, so a slow font server cannot hold up the page load. One known deviation is kept visible as `test.fail`: the detector's worst corner is 5.5% off on the binder photo, just over the 5% limit.

## Run locally

Without sync (static files only):

```bash
python -m http.server 8124 --bind 127.0.0.1 --directory site
```

With sync (Worker + local KV):

```bash
npx wrangler dev --port 8124
```

The camera needs `localhost` or HTTPS.

## Deploy (Cloudflare Worker, like liefvosje)

```bash
npx wrangler kv namespace create SYNC
```

(Already done once; the id is in `wrangler.jsonc`.) Then:

```bash
npx wrangler deploy
```

The app is served at `schatkaart.<account>.workers.dev`.

Card data and prices: TCGdex. Schatkaart is a fan project, not affiliated with Nintendo, The Pokémon
Company, Creatures or Game Freak.
