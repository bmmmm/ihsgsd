# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EDEKA weekly offers viewer — a static web app that displays supermarket product offers in a searchable, filterable table. Data is automatically fetched weekly via GitHub Actions and served via GitHub Pages.

**Tech stack:** Vanilla HTML/CSS/JS, no build tools, no dependencies.

## Running Locally

```bash
python3 -m http.server 8888
# Then open http://localhost:8888
```

No build step, no npm, no package.json. Just serve the root directory.

### Saving preferences into the repo

"Für Montag exportieren" tries three targets in order:

1. **The connected repo folder** (File System Access API). Click "Repo-Ordner
   wählen" once; the handle is kept in IndexedDB and survives reloads, so
   exports, the shopping list and the export-status check read and write the
   real files — **including from the GitHub Pages site**, with no server.
   Chrome/Edge only. The active target is shown in the DOM next to the button.
2. **The dev server** (`python3 scripts/serve.py`), which POSTs to
   `/api/preferences`.
3. **A plain download** you move into `data/` by hand.

Note that `data/preferences.json` is gitignored, so over HTTP it is always a 404
on GitHub Pages — only route 1 can tell whether an export actually exists there.

## Architecture

- **`index.html`** — Landing page linking to the three views (table, dashboard, prospekt). All CSS inline.
- **`table.html`** — Searchable/filterable offer table (logic in `script.js`).
- **`detail-card.js`** — Shared product detail modal used by all three views: click any article to see its Grundpreis history (SVG chart), all-time low/median, offer frequency, and past offers. Reads `data/price-history-index.json` lazily; articles are matched by normalized title, unit/size variants shown as tabs.
- **`dashboard.html`** — EDEKA Dashboard — separate analytics/summary view of the offer data.
- **`prospekt.html` / `prospekt.js`** — Curated weekly flyer with a sticky quick-nav (jump targets + a shopping-list counter that scrolls to the list). Three labelled clusters: **Für dich** (vegan Mo–So meal plan + shopping list first, then the top picks), **Angebote nach Thema** (per-topic sections, which skip anything "Für dich" already showed — both draw from the same offers and used to repeat each other), and **Personalisieren & stöbern** (interest chips, export, full-week browser) at the bottom. Sections collapse by clicking their heading; that state lives in its own localStorage key, deliberately *not* in `prefs`, since the generators must never read view state. Pure client-side prefs in localStorage (interest chips + 👍/👎 votes + per-meal votes), exported to `data/preferences.json` for the generators. The meal plan has a client-side **gluten-free toggle** (`prefs.glutenFree`) that swaps gluten ingredients/steps (Nudeln, Mehl, Couscous, Seitan…) for GF alternatives at render time — display-only, works without the dev server, persisted quietly (no re-export prompt). The three card markers are kept **separate**: 👍/🚫 = taste (ranking only), 🛒 = bought (loyalty), 🧺 = shopping list. The **shopping list** (`prefs.basket`) is fed only by 🧺 gestures — never by 👍/🛒 — merged into offers / pantry / own items. Both feeds are opt-in: 🧺 on an offer card, and 🧺 on a *dinner* card, which puts that dish's whole ingredient list on (`basket.meals`, by slug; "Ganze Woche" in the list header does all seven at once). Every dinner used to land there automatically, which opened the week with 29 rows — a finished list nobody asked for, reading as the page's output rather than as yours, with the two or three things you actually needed buried in it. A first-time visitor instead gets exactly one seeded example row (`seedDemoItem`, guarded by `prefs.demoSeeded`), because an empty list has to show that things go *into* it and a row you can delete says that better than a sentence. It's editable: remove (×), check off, and type own items; the overlay (removed/checked/custom) is bound to a plan key so a new week or regeneration starts fresh. Removal is the page's only destructive gesture and sits in the same row as the checkbox, so it is **undoable** for 12 s — what was taken out is snapshotted first (`removed` is keyed by name, the 🧺 offers and own items by id, so it cannot be re-derived), and the undo refuses to fire once the plan key has moved on. Copy button (clipboard, Markdown checklist) and, on the dev server, a save button (`POST /api/shopping` → gitignored `data/shopping/`).
- **`grundpreis.js`** — Shared Grundpreis logic (parse, derive, product key, size buckets) loaded by all three views before their own scripts. Mirrors `scripts/build_indexes.py`; `scripts/test_parity.py` checks the two against each other.
- **`script.js`** — All frontend logic for `table.html`: data fetching, table rendering, search, category filtering, image toggle, clipboard export. The Grundpreis column and its sort key go through `resolveGp`, so offers where EDEKA quotes no Grundpreis still show and sort by one (marked "≈").
- **`data/`** — Weekly JSON snapshots organized as `data/{YEAR}/KW{XX}/{DATE}.json`. ~17MB total, 70+ files.
- **`data/folder-structure.json`** — Auto-generated index of all data files (used by the dropdown).
- **`data/prospekt.json` / `data/mealplan.json`** — Optional AI editorial (flyer copy / vegan week plan), generated locally; the page renders additively (absence never breaks it).
- **`.github/workflows/fetch-offers.yml`** — Cron job that fetches from the EDEKA API, sorts by category and commits JSON to `data/`. Does **not** run the generators. Runs **Sunday 12:00 and 18:00 CEST plus Monday as a safety net**, because EDEKA publishes the new week on Sunday and GitHub's scheduler is routinely hours late. Snapshots are filed under the API's own **`validFrom`** (the Monday the offers start), not the run date — that is what makes an early run safe: it either lands under next week or writes nothing. Two guards keep repeat runs quiet: a fetch may never *shrink* an archived week (a mid-switch fetch returns a partial list), and a response differing only in image URLs / `criteria` order is discarded (EDEKA mints fresh image UUIDs per request, which would otherwise be ~800 changed lines three times a week).

### Local generation pipeline (manual, needs the `claude` CLI)

Run by hand after a fetch — these call `claude -p` and are never part of CI:

- **`scripts/generate_prospekt.py`** — flyer lead + section intros + ranked "Für dich" picks → `data/prospekt.json`. Applies the reader's diet vetoes *before* ranking, so the model never sees Grillrippen or Fischstäbchen as candidates (the page would hide them anyway — this just stops it writing lead copy about offers nobody will see). A topic the export never decided on falls back to `DEFAULT_INTERESTS`, mirroring `prospekt.js`.
- **`scripts/generate_mealplan.py`** — 12-14 vegan dinners (first 7 = Mo–So plan, rest = swap "bench") from this week's vegan offers + a `VEGAN_STAPLES` pantry + the reader's prefs → `data/mealplan.json`. Imports shared helpers from `generate_prospekt`.
- **`scripts/test_parity.py`** — the repo's only test. Proves the JS and Python copies of the shared logic still agree, over every offer in `data/`. Needs `node`; no framework, no dependencies. Run it after changing `grundpreis.js`, `build_indexes.py` or any diet detector.
- **`scripts/layout-probe.js`** — layout regression check, pasted into the browser console (`await layoutProbe()`; optionally `layoutProbe(['prospekt.html'], [560])`). Loads each page in an off-screen iframe at several widths — so media queries resolve against the probe width, not the real window — and reports words torn mid-syllable, horizontal overflow, and touch targets under 44 px. Breaks at a hyphen and words split by `hyphens: auto` count as correct typography, not defects. Run after CSS changes; same role for layout that `test_parity.py` has for the shared JS/Python logic.
- **`scripts/audit_data.py`** — read-only data-quality audit over every snapshot and both indexes: week identity (folder vs. the API's `validFrom`), duplicate offer weeks, cadence gaps, offer-record sanity, EDEKA's own Grundpreis vs. price ÷ pack size, implausible price swings, index integrity, image-archive coverage — plus the ALDI archive (see the ALDI section). `-v` lists every finding. It deliberately separates *actionable* findings (exit 1) from *historic* ones that cannot be repaired — the three permanently missing weeks, images purged before the archive existed, EDEKA's own typos — which are reported but never fail the run. A check that is permanently red gets ignored, so a non-zero exit always means something changed that is worth fixing.
- **`scripts/serve.py`** — dev server (127.0.0.1) with `POST /api/preferences` (saves the export), `POST /api/shopping` (saves the week's shopping list to `data/shopping/<date>.json`, gitignored; the date is validated `YYYY-MM-DD` and doubles as the path-traversal guard), and `POST /api/mealplan/regenerate` (runs the meal-plan generator live for the page's "↻ Neu generieren" button). `ThreadingHTTPServer` so the long generation doesn't block static serving.

## Data Flow

1. GitHub Actions fetches from `edeka.de/api/auth-proxy/` for market ID `5625811`
2. Response is sorted by `category.name` via `jq` and saved to `data/{YEAR}/KW{XX}/{DATE}.json`
3. `folder-structure.json` is regenerated via `find` + `jq`
4. Frontend loads `folder-structure.json` to populate dropdown, then fetches the selected week's JSON
5. Offers are rendered as table rows with category, price, description, and lazy-loaded images

## ALDI Süd data source (phase 1 — collection only, no UI)

A second, fully separate offer source mirroring the EDEKA pattern:

- **`scripts/fetch_aldi.py`** — stdlib-only fetcher, also runs locally
  (`python3 scripts/fetch_aldi.py [--dry-run]`). Endpoint
  `https://api.aldi-sued.de/v3/product-search` with
  `categoryKey=1588161426582123` (food "Wochenangebote", Mo–Sa); plain JSON, no
  auth, no `servicePoint` needed. `limit` must be one of {12,16,24,30,32,48,60};
  pages are merged via `offset` until `meta.pagination.totalCount`. Non-food
  promotions (`?promotionKey=YYYY-MM-DD`) are a possible later addition. Also
  archives one 320 px thumbnail per offer (~16 KB, keyed by `sku`) into a
  sibling `img/` dir — from week one, because EDEKA purged 75 weeks of images
  before its archive existed; missing images are retried on every run, even
  when the snapshot itself is unchanged.
- **`data-aldi/{YEAR}/KW{XX}/{monday}.json`** — snapshots of raw API product
  objects, sorted by `sku`. Deliberately a **sibling** of `data/`, not a
  subdirectory: the EDEKA workflow's `find -path "data/*/KW*/*.json"` (where `*`
  matches `/`) would otherwise leak ALDI files into `folder-structure.json` and
  the week dropdown, and `build_indexes.py` / `audit_data.py` walk `data/`.
- **Week identity is the Monday of the run's ISO week** — the response has no
  `validFrom` equivalent. A stale-week guard compares against the previous
  week's snapshot, so an early Monday run cannot file last week's offers under
  the new Monday; never-shrink and churn-filter guards mirror the EDEKA
  workflow's.
- **`.github/workflows/fetch-aldi-offers.yml`** — Mon 05:00/10:00 UTC + Tue
  06:00 UTC safety net + `workflow_dispatch`; ALDI's publish time is unknown,
  tune the schedule after observing the switch a few times.
- **Data model facts (KW31 baseline — recheck against week 2):** `categories`
  is a parent→child path (1–2 entries, parent first; ~12 parents ≈ EDEKA's
  `category.name`, except parent "Wochenangebote" is semantically empty — its
  child "Frischeprodukte im Angebot" is the produce section). `badges` carries
  explicit "Vegan"/"Vegetarisch"/"Kühlung"/"Tiefkühlung" labels (curated:
  produce is implicitly vegan but unbadged). `weightType` "2" +
  `quantityUnit` "kg" = loose goods sold per kg, whose `price.amount` IS the
  per-kg price; `quantityUnit` "ea"/"pac"/"bt" = piece/pack/bottle ("bt" rows
  carry `bottleDeposit`). `sellingSize` ("1 kg", "156 g") exists exactly where
  `price.comparison*` does (75/86; correct on spot checks, unvalidated at
  scale) — the 11 lacking both are loose/per-piece produce. `abstractSku`
  groups flavour variants (Grünländer ×5, Coca-Cola family ×3).
  `price.savingsDisplay` ("34 %") is ALDI's own discount figure. Dead fields:
  `notForSale` (always true), `onSaleDateDisplay`, `alcohol`, `energyClass`,
  `ageRestriction`, `discontinued*`, `isAbstract`, `price.additionalInfo`,
  `price.perUnit*` (4/86).
- **Open observations before building on the data:** whether `sku` /
  `abstractSku` are stable across weeks (if yes, price history needs no
  title-normalization heuristic à la EDEKA); whether the category set and
  parent-first order hold; whether the loose-goods per-kg reading matches the
  printed flyer.
- **`audit_data.py` audits every sibling archive** via `check_archive()`:
  misfiled weeks, cadence gaps (a NEW gap = broken cron = exit 1;
  investigated ones move to the known-missing sets and become a note),
  partial snapshots, duplicate keys, image coverage (data-aldi only).
- No UI yet — table/dashboard/prospekt stay EDEKA-only.

## kaufda data source — REWE, Lidl, ALDI SÜD (phase 1 — collection only, no UI)

A third source: flyer offers from kaufda's (Bonial's) content-viewer API,
fetched by **`scripts/fetch_kaufda.py`** into
`data-kaufda/{retailer}/{YEAR}/KW{XX}/{monday}.json` (retailers: `rewe`,
`lidl`, `aldi-sued`). kaufda-ALDI complements the direct ALDI API — the flyer
holds ~164 offers incl. non-food vs. 86 food offers in `data-aldi/`.

- **API**: `https://content-viewer-be.kaufda.de/v1` — no auth, but needs a
  browser User-Agent plus three underscore headers exactly as the
  FST_ERR_VALIDATION error names them (`delivery_channel: web`,
  `user_platform_category: desktop`, `user_platform_os: macos`).
  `GET /brochures/<uuid>?lat&lng` (metadata incl. validFrom/validUntil),
  `GET /brochures/<uuid>/pages?lat&lng` (offers per page). The direct
  retailer sites stay blocked (Lidl wants UA+Origin tricks, REWE 403s) —
  kaufda is the deliberate detour.
- **Discovery is SSR scraping, no seed needed**: the shelf page (regional,
  Bonn lat/lng) and the `/Geschaefte/<retailer>` pages embed `__NEXT_DATA__`
  JSON listing every current brochure with publisher + validFrom. ALDI SÜD
  appears only on its Geschaefte page, not in the Bonn shelf.
- **Offers are normalized, not raw** (unlike data/ and data-aldi/): Bonial's
  nested flyer extracts carry no SKUs and lots of tracking noise. Each offer
  becomes a flat record with our own stable `id` = sha1(retailer|brand|
  names|description)[:12] — it deduplicates regional flyer editions, keeps
  refetches churn-free and matches products across weeks. `kaufdaId` keeps
  the source UUID. Multi-product offers ("versch. Sorten") keep extra names
  in `variants`; `grundpreisText` holds Bonial's "1 kg = 4.51" string
  unparsed (REWE ~72 %, Lidl ~36 % coverage).
- **Snapshots are filed under the brochure's own validFrom week** (Monday of
  that ISO week; validFrom is Sun 22:00/23:00 UTC = Mon 00:00 local, shifted
  +6h before snapping). Like EDEKA, this makes early runs safe — Lidl's
  next-week preview brochure lands as next week's snapshot. Guards: retry,
  ≥30 offers per retailer, never-shrink, churn filter (drops `kaufdaId`/
  `image`/`page`, which flip when regional editions merge in another order).
  One failing retailer only warns; the audit catches a week that never came.
- **Images are deliberately NOT archived** for kaufda: Bonial serves ~290 KB
  originals with no working server-side resize (`impolicy` returns garbage) —
  ~1150 offers/week would be ~330 MB/week. Offer records keep the URL; if a
  UI ever needs them, add a local resize step as a conscious decision.
- **`.github/workflows/fetch-kaufda-offers.yml`** — Mon 05:00/10:00 UTC +
  Tue 06:00 UTC + `workflow_dispatch`, same commit/push retry as the others.

## Key Patterns

- **German compounds get `hyphens: auto`, never `overflow-wrap: anywhere`.**
  Product names and category labels are long single words in narrow columns
  ("Grundnahrung" needed 103 px in a 99 px table cell). `anywhere` permits a
  break at *any* character and produced "Mö/hre/n" in a 35 px box;
  `hyphens: auto` uses the browser's German dictionary (documents are
  `lang="de"`) and yields "Grund-nahrung". Where a row mixes text with badges,
  give the text a `min-width` in `ch` — that, not the wrap mode, is what stops
  a flex item from collapsing to nothing.
- **Touch targets live behind `@media (pointer: coarse)`.** The pages stay dense
  under a mouse; only coarse pointers get 44 px hit areas. Matters most in the
  shopping list, where `×` deletes a row right next to the checkbox.
- **A 44 px button is not a 44 px hit area if the rows are 28 px apart.** The
  first version of that rule kept the list dense and let the buttons bleed into
  their neighbours with `margin: -10px 0`. Both buttons measured 44×44 and it
  was still hard to hit: 27 of 28 consecutive row pairs overlapped by up to
  12 px, and the row *below* paints over the one above, so the reliably tappable
  strip was back to the row height. The row itself has to grow (`min-height`).
  Measuring the button alone cannot see this — check the vertical gap between
  neighbouring rows' buttons, and expect a real fix to make the list taller.
- **Anything toggled with the `hidden` property needs `[hidden] { display: none
  !important }`.** `hidden` only works through the UA rule, which *any* author
  `display` outranks — so `.pk-sl-undo { display: flex }` left the undo bar
  visible-but-empty from the first paint, and a `display: inline-flex` inside
  the `pointer: coarse` block re-showed the emptied basket counter on phones
  only. Testing `el.hidden` in JS reads the property and passes happily while
  the thing is on screen; the discriminating check is
  `getComputedStyle(el).display`.
- **The sticky bar's height is measured, not assumed.** `scroll-margin-top` has
  to match the jump bar, which is one row wide, two rows narrow, and taller
  again when the basket counter appears. Two hardcoded values were wrong at
  every width but one, and a jump landed with the heading already behind the
  bar. `syncJumpHeight()` writes the measured height to `--pk-jump-h` under a
  `ResizeObserver`, which covers viewport, wrapping and counter at once.
- **Grundpreis is derived when EDEKA omits it.** EDEKA leaves out the €/kg
  exactly where the pack already IS the base unit ("Möhren, 1 kg Schale,
  € 1.29") — 26 % of offers, which used to drop them from the price history
  entirely (no chart, no all-time-low badge). `derive_gp()` computes it from
  price ÷ pack size, skipping multipacks ("6 x 0,33 l", "2 Stück à 50 g") and
  loose goods ("offene 400 g Schale") where that maths would be wrong.
  Validated at 99.7 % against the offers carrying both values, so derived
  values count as exact and only carry a `gpd` display tag — rendered as "≈" in
  the table, on the cards and in the detail card's history.
- **Run `scripts/test_parity.py` after touching the shared logic.** The
  Grundpreis code and the diet detectors exist in both JS and Python
  (`grundpreis.js` ↔ `build_indexes.py`, `prospekt.js` ↔
  `generate_prospekt.py`). Drift is silent — a product key off by one character
  yields zero history lookups, so badges just stop appearing with no error. The
  test loads the real JS files under Node and compares both sides over every
  offer in `data/`. Use the full run: `--quick` is a smoke test and provably
  misses detector drift (deleting "bockwurst" from the JS detector passes
  `--quick`, because the newest week has no Bockwurst offer).
- **Shared browser code goes in its own file, loaded first.** `grundpreis.js`
  and `detail-card.js` are loaded by table/prospekt/dashboard ahead of their own
  scripts. When moving something there, delete the local copy — `dashboard.js`
  had its own `const FACE_MAX`, and a second one at global scope is a
  redeclaration SyntaxError that takes the whole page down.
- **"aus" is a veto, not a penalty.** A muted topic used to be a −4 score
  summand that two +4 matches could outvote, which is how Jägermeister and
  Fischstäbchen survived under Top-Knüller. `vetoedBy()` makes it absolute:
  diet topics (Fleisch / Fisch / Wein & Spirituosen) never yield, other topics
  yield to an explicitly liked one so "Getränke aus" + "Bier Favorit" still
  shows the pils. `isHidden()` is the single visibility rule for every surface.
- **Title detectors need Unicode word boundaries.** JS `\b` is ASCII-only, so
  `ä` ends a word: `/\brum\b/` matched "**Rum**änien" and filed blueberries as
  spirits. Use the `dietRe()` helper (`[\p{L}\p{N}]` lookarounds), never bare
  `\b`, and never an unbounded substring — `/spezi/` matched "Gebäck**spezi**-
  alitäten" and "Fisch**spezi**alitäten", scoring biscuits and fish as a
  favourite. Python's `\b` *is* Unicode-aware, so the mirrored regexes in
  `generate_prospekt.py` use plain `\b`.
- **Meat and fish are detected by title, not category.** Fish sticks and
  chicken nuggets live in Tiefkühl, Bockwurst and tuna in Grundnahrung,
  Räucherlachs in Molkerei & Käse. A vegan/vegetarian title always wins over a
  meat word, or muting "Fleisch" would hide the vegan sausages. Detection reads
  the **title only** — scanning `description` also flags "Sauerkraut, die ideale
  Beilage zum Kasseler", and a mention is not an ingredient.
- **Editorial is gated on its own `weekLabel`.** `activeProspekt()` /
  `activeMealplan()` return `null` when the file belongs to another week, and a
  banner names what is stale. Without this the page happily showed last week's
  copy above this week's offers — which is exactly what happened when the local
  sync job failed for a week.

- Event listeners for search, category filter, and image toggle are registered **once** in `initializePage()` — not per data load. The image toggle queries `.image-cell` elements dynamically inside its click handler.
- Category filter is checkbox pills (`#category-filters`); `HIDDEN_CATEGORIES_DEFAULT` in script.js (Fleisch & Wurst, Drogerie, Tiernahrung, Fisch & Meeresfrüchte) starts unchecked/hidden.
- Images use two URLs from the API: `web90` for thumbnails, `original` for hover preview (desktop only — preview is gated on `(hover: hover)`).
- The "Produkte kopieren" button formats visible products as a JSON block wrapped in an LLM prompt template.
- Table column widths are controlled via `<colgroup>` with percentage-based `col` classes.

## GitHub Pages

Deployed from the `main` branch root. No build step — `index.html` and `data/` are served directly.
