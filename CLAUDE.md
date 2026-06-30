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

To let the Prospekt page save preferences straight into `data/preferences.json`
(instead of downloading a file you move by hand), use the dev server instead:

```bash
python3 scripts/serve.py        # serves the repo AND POST /api/preferences
```

The "Für Montag exportieren" button posts to that endpoint when available and
falls back to a plain download with `http.server`.

## Architecture

- **`index.html`** — Single-page app with dark theme, contains all CSS inline in `<style>`.
- **`table.html`** — Alternative table view of the same offer data (different layout/presentation).
- **`dashboard.html`** — EDEKA Dashboard — separate analytics/summary view of the offer data.
- **`prospekt.html` / `prospekt.js`** — Curated weekly flyer, grouped into three labelled clusters: **Für dich** (top picks + vegan Mo–So meal plan + shopping list), **Angebote nach Thema** (per-topic sections), and **Personalisieren & stöbern** (interest chips, export, full-week browser) at the bottom. Pure client-side prefs in localStorage (interest chips + 👍/👎 votes + per-meal votes), exported to `data/preferences.json` for the generators. The meal plan has a client-side **gluten-free toggle** (`prefs.glutenFree`) that swaps gluten ingredients/steps (Nudeln, Mehl, Couscous, Seitan…) for GF alternatives at render time — display-only, works without the dev server, persisted quietly (no re-export prompt). The three card markers are kept **separate**: 👍/🚫 = taste (ranking only), 🛒 = bought (loyalty), 🧺 = shopping list. The **shopping list** (`prefs.basket`) is fed only by the meal plan's ingredients (incl. GF swaps) and 🧺-added offers — never by 👍/🛒 — merged into offers / pantry / own items. It's editable: remove (×), check off, and type own items; the overlay (removed/checked/custom) is bound to a plan key so a new week or regeneration starts fresh. Copy button (clipboard, Markdown checklist) and, on the dev server, a save button (`POST /api/shopping` → gitignored `data/shopping/`).
- **`script.js`** — All frontend logic for `index.html`: data fetching, table rendering, search, category filtering, image toggle, clipboard export.
- **`data/`** — Weekly JSON snapshots organized as `data/{YEAR}/KW{XX}/{DATE}.json`. ~17MB total, 70+ files.
- **`data/folder-structure.json`** — Auto-generated index of all data files (used by the dropdown).
- **`data/prospekt.json` / `data/mealplan.json`** — Optional AI editorial (flyer copy / vegan week plan), generated locally; the page renders additively (absence never breaks it).
- **`.github/workflows/fetch-offers.yml`** — Cron job (every Monday 5AM) that fetches from EDEKA API, sorts by category, commits JSON to `data/`. Does **not** run the generators.

### Local generation pipeline (manual, needs the `claude` CLI)

Run by hand after a fetch — these call `claude -p` and are never part of CI:

- **`scripts/generate_prospekt.py`** — flyer lead + section intros + ranked "Für dich" picks → `data/prospekt.json`.
- **`scripts/generate_mealplan.py`** — 12-14 vegan dinners (first 7 = Mo–So plan, rest = swap "bench") from this week's vegan offers + a `VEGAN_STAPLES` pantry + the reader's prefs → `data/mealplan.json`. Imports shared helpers from `generate_prospekt`.
- **`scripts/serve.py`** — dev server (127.0.0.1) with `POST /api/preferences` (saves the export), `POST /api/shopping` (saves the week's shopping list to `data/shopping/<date>.json`, gitignored; the date is validated `YYYY-MM-DD` and doubles as the path-traversal guard), and `POST /api/mealplan/regenerate` (runs the meal-plan generator live for the page's "↻ Neu generieren" button). `ThreadingHTTPServer` so the long generation doesn't block static serving.

## Data Flow

1. GitHub Actions fetches from `edeka.de/api/auth-proxy/` for market ID `5625811`
2. Response is sorted by `category.name` via `jq` and saved to `data/{YEAR}/KW{XX}/{DATE}.json`
3. `folder-structure.json` is regenerated via `find` + `jq`
4. Frontend loads `folder-structure.json` to populate dropdown, then fetches the selected week's JSON
5. Offers are rendered as table rows with category, price, description, and lazy-loaded images

## Key Patterns

- Event listeners for search, category filter, and image toggle are registered **once** in `initializePage()` — not per data load. The image toggle queries `.image-cell` elements dynamically inside its click handler.
- Category filter uses a `<select multiple>` — "Fleisch & Wurst" and "Tiernahrung" are pre-selected by default.
- Images use two URLs from the API: `web90` for thumbnails, `original` for hover preview.
- The "Produkte kopieren" button formats visible products as a JSON block wrapped in an LLM prompt template.
- Table column widths are controlled via `<colgroup>` with percentage-based `col` classes.

## GitHub Pages

Deployed from the `main` branch root. No build step — `index.html` and `data/` are served directly.
