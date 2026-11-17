# Schatkaart

**Live:** https://schatkaart.julietous.workers.dev

A cute, phone-first Pokémon card scanner. Point your camera at a card: a glowing outline snaps to the
card's edges, Schatje (a treasure chest with googly eyes) reads it, asks *"Is this your card?"*, and shows
every print with the same name so you can pick the exact set and number. Since v3 the prints are grouped per artwork (Art 1, Art 2…), each with its set code, number, year and type (secret rare, full art, illustration rare, promo…). Then it shows the price.

Made for yard sales (scan a stack onto the **pile** and see its total) and for sorting a **collection**.

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
| UI | `tests/ui/` | Welcome window, search, the pile and its total, undo, price source, collection, JSON/CSV export and import on a second device, camera errors, an axe accessibility scan |

74 tests, stable over repeated runs. One known deviation is kept visible as `test.fail`: the detector's worst corner is 5.5% off on the binder photo, just over the 5% limit.

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
