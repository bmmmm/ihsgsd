# CLAUDE.md

EDEKA weekly offers viewer — a static site showing supermarket offers in a
searchable table, a dashboard and a curated flyer. Vanilla HTML/CSS/JS, no build
step, no dependencies, served from `main` via GitHub Pages.

**The detailed rationale for a rule lives as a comment at the code it governs**
— diet detectors and Grundpreis derivation in `build_indexes.py` /
`generate_prospekt.py`, the CSS hit-area and `[hidden]` rules in
`prospekt.html`, the anchor-offset measurement at `syncJumpHeight()`. This file
only carries what spans files or is not visible from any single one.

## Running locally

```bash
python3 -m http.server 8888      # static only
python3 scripts/serve.py         # + POST /api/preferences, /api/shopping, /api/mealplan/regenerate
```

## Layout

- `table.html` + `script.js` — the offer table.
- `dashboard.html` — analytics view.
- `prospekt.html` + `prospekt.js` — curated flyer: meal plan, shopping list,
  interest chips, votes. Prefs live in localStorage and are exported to
  `data/preferences.json` for the generators.
- `grundpreis.js`, `detail-card.js` — shared, loaded before the page scripts.
- `data/{YEAR}/KW{XX}/{DATE}.json` — weekly EDEKA snapshots (~17 MB, 70+ files),
  indexed by `data/folder-structure.json`.
- `data/prospekt.json`, `data/mealplan.json`, `data/insights.json` — optional AI
  editorial. The pages render additively: a missing or stale file never breaks
  them, it just hides that block.

## Data sources

EDEKA is the only one with a UI. Two further sources collect only:
`data-aldi/` (direct ALDI API) and `data-kaufda/{retailer}/` (REWE, Lidl, ALDI
via kaufda). Each has its own fetcher in `scripts/` and its own workflow; the
fetchers document their API quirks.

Both are **siblings of `data/`, never subdirectories** — the EDEKA workflow
globs `data/*/KW*/*.json` where `*` spans `/`, so a nested archive would leak
into the week dropdown, and `build_indexes.py` / `audit_data.py` walk `data/`.

Snapshots are filed under the week the offers *start*, not the run date (EDEKA's
own `validFrom`; ISO-week Monday elsewhere). That is what makes an early run
safe — it either lands in next week or writes nothing.

## Generation pipeline (manual, local)

`generate_prospekt.py`, `generate_mealplan.py` and `generate_insights.py` run by
hand after a fetch, never in CI. All three go through
`generate_prospekt.run_model()`: `claude -p` first, and if that is missing or
fails, a **local** OpenAI-compatible engine (oMLX) — discovered via `/v1/models`,
no model hardcoded. The engine that answered is named in the output.

The fallback is local on purpose, and hosted free tiers are not an option here:
diet vetoes are applied *before* the digest is built, so the surviving selection
discloses the reader's diet even without the preference block — the selection is
the profile. `scripts/bench-prospekt-free.py` documents the measurement.

`weekly_sync.sh` (launchd) syncs the Actions data commit and runs the generators.
It **hardcodes its PATH** because launchd supplies a bare `/usr/bin:/bin` — when
a tool it calls moves, that line must move with it. Its phases are independent,
so a broken generator is invisible from outside: data keeps flowing and the site
looks healthy under last week's copy. Check `~/ops/logs/ihsgsd-sync.log` before
believing a schedule was missed; redundant cron slots only help against
*transient* faults.

## Before you change things

- **Run `scripts/test_parity.py` after touching shared logic** — the Grundpreis
  code and diet detectors exist in both JS and Python, and drift is silent (a
  product key off by one character just stops returning history). Use the full
  run; `--quick` provably misses detector drift.
- **Moving code into a shared file means deleting the local copy** — a second
  `const` at global scope is a redeclaration SyntaxError that takes the page
  down.
- **The repo is public.** `data/preferences.json`, `data/receipts.json` and
  `data/shopping/` are gitignored and must stay that way.
- **`tmp/` is gitignored** — a finding you want to see again goes into a tracked
  file, a `# FIXME` at the code site, or an issue.
- **German compounds need `hyphens: auto`, never `overflow-wrap: anywhere`** —
  the latter breaks at any character and yields "Mö/hre/n".
- **`scripts/audit_data.py`** is the read-only data-quality check across all
  archives; a non-zero exit always means something new and fixable.
  `scripts/layout-probe.js` does the same for layout, pasted into the console.
