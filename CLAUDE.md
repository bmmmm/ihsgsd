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
- **`prospekt.html` / `prospekt.js`** — Curated weekly flyer with a sticky quick-nav (jump targets + a shopping-list counter that scrolls to the list). Three labelled clusters: **Für dich** (vegan Mo–So meal plan + shopping list first, then the top picks), **Angebote nach Thema** (per-topic sections, which skip anything "Für dich" already showed — both draw from the same offers and used to repeat each other), and **Personalisieren & stöbern** (interest chips, export, full-week browser) at the bottom. Sections collapse by clicking their heading; that state lives in its own localStorage key, deliberately *not* in `prefs`, since the generators must never read view state. Pure client-side prefs in localStorage (interest chips + 👍/👎 votes + per-meal votes), exported to `data/preferences.json` for the generators. The meal plan has a client-side **gluten-free toggle** (`prefs.glutenFree`) that swaps gluten ingredients/steps (Nudeln, Mehl, Couscous, Seitan…) for GF alternatives at render time — display-only, works without the dev server, persisted quietly (no re-export prompt). The three card markers are kept **separate**: 👍/🚫 = taste (ranking only), 🛒 = bought (loyalty), 🧺 = shopping list. The **shopping list** (`prefs.basket`) is fed only by the meal plan's ingredients (incl. GF swaps) and 🧺-added offers — never by 👍/🛒 — merged into offers / pantry / own items. It's editable: remove (×), check off, and type own items; the overlay (removed/checked/custom) is bound to a plan key so a new week or regeneration starts fresh. Copy button (clipboard, Markdown checklist) and, on the dev server, a save button (`POST /api/shopping` → gitignored `data/shopping/`).
- **`script.js`** — All frontend logic for `index.html`: data fetching, table rendering, search, category filtering, image toggle, clipboard export.
- **`data/`** — Weekly JSON snapshots organized as `data/{YEAR}/KW{XX}/{DATE}.json`. ~17MB total, 70+ files.
- **`data/folder-structure.json`** — Auto-generated index of all data files (used by the dropdown).
- **`data/prospekt.json` / `data/mealplan.json`** — Optional AI editorial (flyer copy / vegan week plan), generated locally; the page renders additively (absence never breaks it).
- **`.github/workflows/fetch-offers.yml`** — Cron job that fetches from the EDEKA API, sorts by category and commits JSON to `data/`. Does **not** run the generators. Runs **Sunday 12:00 and 18:00 CEST plus Monday as a safety net**, because EDEKA publishes the new week on Sunday and GitHub's scheduler is routinely hours late. Snapshots are filed under the API's own **`validFrom`** (the Monday the offers start), not the run date — that is what makes an early run safe: it either lands under next week or writes nothing. Two guards keep repeat runs quiet: a fetch may never *shrink* an archived week (a mid-switch fetch returns a partial list), and a response differing only in image URLs / `criteria` order is discarded (EDEKA mints fresh image UUIDs per request, which would otherwise be ~800 changed lines three times a week).

### Local generation pipeline (manual, needs the `claude` CLI)

Run by hand after a fetch — these call `claude -p` and are never part of CI:

- **`scripts/generate_prospekt.py`** — flyer lead + section intros + ranked "Für dich" picks → `data/prospekt.json`. Applies the reader's diet vetoes *before* ranking, so the model never sees Grillrippen or Fischstäbchen as candidates (the page would hide them anyway — this just stops it writing lead copy about offers nobody will see). A topic the export never decided on falls back to `DEFAULT_INTERESTS`, mirroring `prospekt.js`.
- **`scripts/generate_mealplan.py`** — 12-14 vegan dinners (first 7 = Mo–So plan, rest = swap "bench") from this week's vegan offers + a `VEGAN_STAPLES` pantry + the reader's prefs → `data/mealplan.json`. Imports shared helpers from `generate_prospekt`.
- **`scripts/serve.py`** — dev server (127.0.0.1) with `POST /api/preferences` (saves the export), `POST /api/shopping` (saves the week's shopping list to `data/shopping/<date>.json`, gitignored; the date is validated `YYYY-MM-DD` and doubles as the path-traversal guard), and `POST /api/mealplan/regenerate` (runs the meal-plan generator live for the page's "↻ Neu generieren" button). `ThreadingHTTPServer` so the long generation doesn't block static serving.

## Data Flow

1. GitHub Actions fetches from `edeka.de/api/auth-proxy/` for market ID `5625811`
2. Response is sorted by `category.name` via `jq` and saved to `data/{YEAR}/KW{XX}/{DATE}.json`
3. `folder-structure.json` is regenerated via `find` + `jq`
4. Frontend loads `folder-structure.json` to populate dropdown, then fetches the selected week's JSON
5. Offers are rendered as table rows with category, price, description, and lazy-loaded images

## Key Patterns

- **Grundpreis is derived when EDEKA omits it.** EDEKA leaves out the €/kg
  exactly where the pack already IS the base unit ("Möhren, 1 kg Schale,
  € 1.29") — 26 % of offers, which used to drop them from the price history
  entirely (no chart, no all-time-low badge). `derive_gp()` computes it from
  price ÷ pack size, skipping multipacks ("6 x 0,33 l", "2 Stück à 50 g") and
  loose goods ("offene 400 g Schale") where that maths would be wrong.
  Validated at 99.7 % against the offers carrying both values, so derived
  values count as exact and only carry a `gpd` display tag ("≈" on the card).
  `build_indexes.py` and `prospekt.js` hold parallel implementations — change
  both together or lookups silently return nothing.
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
