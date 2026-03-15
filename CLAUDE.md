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

## Architecture

- **`index.html`** — Single-page app with dark theme, contains all CSS inline in `<style>`.
- **`script.js`** — All frontend logic: data fetching, table rendering, search, category filtering, image toggle, clipboard export.
- **`data/`** — Weekly JSON snapshots organized as `data/{YEAR}/KW{XX}/{DATE}.json`. ~17MB total, 70+ files.
- **`data/folder-structure.json`** — Auto-generated index of all data files (used by the dropdown).
- **`.github/workflows/fetch-offers.yml`** — Cron job (every Monday 5AM) that fetches from EDEKA API, sorts by category, commits JSON to `data/`.

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
