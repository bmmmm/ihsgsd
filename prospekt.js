// EDEKA Wochen-Prospekt — a curated weekly flyer of the offers we care about
// (vegan, fruit & veg, beer & Spezi, Superknueller), with a small local
// "interests" tool that learns what the reader likes.
//
// Two layers, fully decoupled so the page never breaks:
//  1. The product cards always render straight from the week's data file.
//  2. Editorial copy (lead + per-section intros + per-product reasons) comes
//     from the OPTIONAL data/prospekt.json, generated locally on Mondays via
//     `claude -p` (scripts/generate_prospekt.py). Missing/malformed file ->
//     the copy is just omitted, the cards stay.
//
// The interests tool is pure client-side: preferences live in localStorage and
// re-rank the cards instantly. "Fuer Montag exportieren" downloads them as
// preferences.json, which generate_prospekt.py reads to personalise next week's
// editorial — that is the full learning loop.

const PREFS_STORE = 'edeka-prospekt-prefs-v1';

let currentOffers = [];     // offers of the selected week
let prospektData = null;    // optional AI editorial (data/prospekt.json)
let mealplanData = null;    // optional vegan week plan (data/mealplan.json)
let mealplanView = null;    // live working copy { days:[{day,meal}], bench:[meal] } (swaps)
let localApi = false;       // is scripts/serve.py (write endpoints) reachable?
let prefs = null;           // { interests:{key:level}, votes:{title:±1}, ... }
let priceHistory = null;    // optional cross-week index (data/price-history-index.json)
let phByKey = null;         // Map(product.key -> product) for O(1) lookup

// Mo–So short label -> full German weekday for the meal-plan day headers.
const WEEKDAYS_FULL = { Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag', Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag' };

const CATEGORY_COLORS = {
    'Drogerie': '#ab47bc',
    'Fleisch & Wurst': '#ef5350',
    'Getränke': '#42a5f5',
    'Grundnahrung': '#ffa726',
    'Knabbern & Naschen': '#ec407a',
    'Molkerei & Käse': '#ffee58',
    'Obst & Gemüse': '#66bb6a',
    'Tiefkühl': '#26c6da',
    'Tiernahrung': '#8d6e63',
    'Fisch & Meeresfrüchte': '#29b6f6',
};

// ── small shared helpers (kept local — each page script is standalone) ──
function catName(o) {
    return (o && o.category && o.category.name) || '';
}

function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    return /^https?:\/\//i.test(url.trim()) ? url : '';
}

function fileDate(file) {
    const m = file.match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
}

function formatDate(d) {
    const p = String(d).split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
}

function formatEuro(n) {
    return `${Number(n).toFixed(2)} €`;
}

const FACE_MAX = 500;
function offerPrice(o) {
    const raw = o && o.price ? o.price.rawValue : undefined;
    const v = Number.isFinite(raw) ? raw : parseFloat(o && o.price ? o.price.value : NaN);
    return (Number.isFinite(v) && v >= 0 && v <= FACE_MAX) ? v : null;
}

function isKnuller(o) {
    return Array.isArray(o.criteria) && o.criteria.some(c => c && c.name === 'Superknüller');
}

// Local archived thumbnail of the selected week, e.g. data/2026/KW26/img/123.jpg.
function localImageUrl(o) {
    const sel = document.getElementById('week-select');
    const file = sel ? sel.value : '';
    const dir = file.replace(/\/[^/]+$/, '');
    if (!dir || o == null || o.id == null) return '';
    return `data/${dir}/img/${encodeURIComponent(o.id)}.jpg`;
}

// <img> with local archive first, live URL as onerror fallback, or null.
function buildOfferImage(o) {
    const liveUrl = (o.images && safeImageUrl(o.images.app || o.images.original || '')) || '';
    const localUrl = localImageUrl(o);
    const src = localUrl || liveUrl;
    if (!src) return null;
    const img = document.createElement('img');
    img.src = src;
    img.alt = o.title || '';
    img.loading = 'lazy';
    if (localUrl && liveUrl) img.onerror = function () { this.onerror = null; this.src = liveUrl; };
    return img;
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json();
}

// ── Grundpreis (€/unit) parsing — a faithful JS port of scripts/build_indexes.py
// so the per-product identity key matches the precomputed index byte-for-byte.
// Any divergence here silently yields zero lookups (no badges), so the parity
// test in tmp/ guards it.
const VOL_WEIGHT_FACTOR = { ml: 0.001, l: 1.0, g: 0.001, kg: 1.0 };
const UNIT_DISPLAY = { wa: 'WA', tab: 'Tab', st: 'St', stk: 'St' };
// "1 kg = € 12.50", "1 l = ab € 0.12", "1 l = € 15.27 / € 45.80".
const GP_RE = /1\s*([A-Za-z]{1,3})\s*=\s*(ab\s*)?€\s*([\d.,]+)(?:\s*\/\s*€\s*([\d.,]+))?/;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\b/i;
const COUNT_RE = /(\d+(?:[.,]\d+)?)\s*(WA|Tabs?|Caps?|St(?:ü|ue)ck|Stk|WL)\b/i;

function gpNormStr(s) {
    return (s == null ? '' : String(s)).replace(/\u00a0/g, ' ').trim();
}

// Mirrors build_indexes.parse_number: tolerant of German grouping. Returns NaN
// (not a throw) on garbage so callers skip rather than guess.
function parseNumberDe(s) {
    s = String(s).trim();
    if (s.indexOf('.') !== -1 && s.indexOf(',') !== -1) {
        s = s.replace(/\./g, '').replace(/,/g, '.');   // dot=thousands, comma=decimal
    } else {
        s = s.replace(/,/g, '.');
    }
    // Mirror Python float(): reject leftover separators / garbage instead of
    // silently truncating (parseFloat("1.2.3") would otherwise return 1.2).
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return NaN;
    return parseFloat(s);
}

// { val, unit, flag } for the Grundpreis, or all-null. flag: exact|range|lower.
function parseGp(offer) {
    for (const src of [offer && offer.basicPrice, offer && offer.description]) {
        const m = GP_RE.exec(gpNormStr(src));
        if (!m) continue;
        const val = parseNumberDe(m[3]);
        if (!Number.isFinite(val)) continue;
        const flag = m[2] ? 'lower' : (m[4] ? 'range' : 'exact');
        const unit = m[1].toLowerCase();
        return { val, unit: UNIT_DISPLAY[unit] || unit, flag };
    }
    return { val: null, unit: null, flag: null };
}

function normTitle(title) {
    return gpNormStr(title).toLowerCase().replace(/\s+/g, ' ');
}

// Coarse order-of-magnitude size class from baseUnit (see build_indexes.py).
function sizeBucket(baseunit) {
    const s = gpNormStr(baseunit);
    let m = SIZE_RE.exec(s);
    if (m) {
        let val = parseNumberDe(m[1]); if (!Number.isFinite(val)) val = 0;
        const unit = m[2].toLowerCase();
        const base = val * VOL_WEIGHT_FACTOR[unit];
        if (base > 0) {
            const dim = (unit === 'ml' || unit === 'l') ? 'v' : 'w';
            return dim + String(Math.floor(Math.log10(base)));
        }
    }
    m = COUNT_RE.exec(s);
    if (m) {
        let val = parseNumberDe(m[1]); if (!Number.isFinite(val)) val = 0;
        if (val > 0) return 'c' + String(Math.floor(Math.log10(val)));
    }
    return '?';
}

// Composite cross-week identity: title + Grundpreis-unit + size class.
function productKey(offer, unit) {
    return `${normTitle(offer && offer.title)}|${unit}|${sizeBucket(offer && offer.baseUnit)}`;
}

// ── interest topics: the steering chips + the detectors used for scoring ──
// `key` doubles as the localStorage interest key and (for the section topics)
// the prospekt.json `sections` key.
const TOPICS = [
    { key: 'vegan',       label: 'Vegan',           emoji: '🌱', test: o => /vegan|vegetar/i.test(o.title || '') },
    { key: 'obstgemuese', label: 'Obst & Gemüse',   emoji: '🥦', test: o => catName(o) === 'Obst & Gemüse' },
    { key: 'bier',        label: 'Bier',            emoji: '🍺', test: o => catName(o) === 'Getränke' && /\bbier\b|pils/i.test(o.title || '') },
    { key: 'spezi',       label: 'Spezi',           emoji: '🥤', test: o => /spezi/i.test(o.title || '') },
    { key: 'bio',         label: 'Bio',             emoji: '🌿', test: o => /\bbio\b/i.test(o.title || '') },
    { key: 'knueller',    label: 'Knüller',         emoji: '🔥', test: isKnuller },
    { key: 'kaese',       label: 'Käse',            emoji: '🧀', test: o => catName(o) === 'Molkerei & Käse' },
    { key: 'suess',       label: 'Süßes',           emoji: '🍫', test: o => catName(o) === 'Knabbern & Naschen' },
    { key: 'fleisch',     label: 'Fleisch & Wurst', emoji: '🥩', test: o => catName(o) === 'Fleisch & Wurst' },
    { key: 'tk',          label: 'Tiefkühl',        emoji: '❄️', test: o => catName(o) === 'Tiefkühl' },
    { key: 'grundnahrung',label: 'Grundnahrung',    emoji: '🍝', test: o => catName(o) === 'Grundnahrung' },
    { key: 'drogerie',    label: 'Drogerie',        emoji: '🧴', test: o => catName(o) === 'Drogerie' },
    { key: 'tiernahrung', label: 'Tiernahrung',     emoji: '🐾', test: o => catName(o) === 'Tiernahrung' },
    { key: 'fisch',       label: 'Fisch',           emoji: '🐟', test: o => catName(o) === 'Fisch & Meeresfrüchte' },
];

// The reader told us up front what they love — seed those at "Favorit". The
// drugstore / pet-food / fish categories are seeded OFF (the durable taste
// profile never wants them); only affects fresh users, existing prefs are kept.
const DEFAULT_INTERESTS = { vegan: 2, obstgemuese: 2, bier: 2, spezi: 2, bio: 1, drogerie: -1, tiernahrung: -1, fisch: -1 };

// How many cards the "Für dich" highlights grid shows at most (LLM-ranked picks
// plus client-score fallback). Matches the generator's foryou target so a full
// week of good matches isn't truncated.
const FORYOU_MAX = 16;

// Topics whose membership is a plain category match (catName === X), so a vote's
// category is unambiguous. Used when a category is switched OFF to drop its now
// redundant 👎 votes. Title-based topics (vegan/bio/spezi/bier/knueller) overlap
// across categories and are deliberately absent here — they are never auto-pruned.
const CATEGORY_FOR_TOPIC = {
    obstgemuese: 'Obst & Gemüse',
    kaese: 'Molkerei & Käse',
    suess: 'Knabbern & Naschen',
    fleisch: 'Fleisch & Wurst',
    tk: 'Tiefkühl',
    grundnahrung: 'Grundnahrung',
    drogerie: 'Drogerie',
    tiernahrung: 'Tiernahrung',
    fisch: 'Fisch & Meeresfrüchte',
};

// Interest levels and how each one weighs into an offer's score.
const LEVELS = {
    '-1': { label: 'aus',     weight: -4, cls: 'lvl-off' },
    '0':  { label: 'neutral', weight: 0,  cls: 'lvl-neutral' },
    '1':  { label: 'mag ich', weight: 2,  cls: 'lvl-like' },
    '2':  { label: 'Favorit', weight: 4,  cls: 'lvl-fav' },
};
const LEVEL_CYCLE = [0, 1, 2, -1];   // chip click order
const VOTE_WEIGHT = 6;               // a thumb outweighs topic interest
const BOUGHT_WEIGHT = 1;             // a mild loyalty nudge for items you actually buy

// ── preferences (localStorage) ──
// The shopping basket is the curated weekly list. It is deliberately separate
// from votes (👍/🚫 = taste/ranking) and bought (🛒 = loyalty): only the 🧺
// gesture and the meal plan feed it. Overlay state (removed/checked/custom) is
// bound to a plan key so a new week or regeneration starts a fresh list.
function emptyBasket() {
    return { planKey: '', offers: {}, custom: [], removed: {}, checked: {} };
}

function normalizeBasket(b) {
    if (!b || typeof b !== 'object') return emptyBasket();
    return {
        planKey: typeof b.planKey === 'string' ? b.planKey : '',
        offers: (b.offers && typeof b.offers === 'object') ? b.offers : {},
        custom: Array.isArray(b.custom) ? b.custom.filter(c => c && typeof c.name === 'string') : [],
        removed: (b.removed && typeof b.removed === 'object') ? b.removed : {},
        checked: (b.checked && typeof b.checked === 'object') ? b.checked : {},
    };
}

function defaultPrefs() {
    return { version: 1, interests: { ...DEFAULT_INTERESTS }, votes: {}, bought: {}, meals: {}, glutenFree: false, basket: emptyBasket() };
}

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_STORE);
        if (!raw) { prefs = defaultPrefs(); return; }
        const p = JSON.parse(raw);
        prefs = {
            version: 1,
            interests: (p && typeof p.interests === 'object' && p.interests) ? p.interests : { ...DEFAULT_INTERESTS },
            votes: (p && typeof p.votes === 'object' && p.votes) ? p.votes : {},
            bought: (p && typeof p.bought === 'object' && p.bought) ? p.bought : {},
            // Per-meal 👍/👎 (keyed by meal slug) — the meal-plan learning signal.
            meals: (p && typeof p.meals === 'object' && p.meals) ? p.meals : {},
            // Gluten-free display toggle: swaps pasta/flour/etc. for GF
            // alternatives in the meal plan. Display-only preference, persisted
            // quietly (no re-export nag) — see persistPrefsQuiet.
            glutenFree: (p && typeof p.glutenFree === 'boolean') ? p.glutenFree : false,
            // Shopping list (🧺-added offers + meal plan + own items). View
            // state, persisted quietly; reset per plan via ensureBasketForPlan.
            basket: normalizeBasket(p && p.basket),
            // Keep the last-changed stamp across reloads so the page can tell
            // whether data/preferences.json still matches the live prefs.
            updatedAt: (p && typeof p.updatedAt === 'string') ? p.updatedAt : undefined,
        };
    } catch (err) {
        prefs = defaultPrefs();
    }
}

function savePrefs() {
    try {
        prefs.updatedAt = new Date().toISOString();
        localStorage.setItem(PREFS_STORE, JSON.stringify(prefs));
    } catch (err) {
        // private mode / storage disabled — keep working in memory only.
    }
}

// Persist prefs WITHOUT bumping updatedAt — for display-only preferences (the
// gluten-free toggle) the Monday generator doesn't read yet, so a "re-export"
// prompt would just be noise. Mirrors backfillVoteCategories' quiet write.
function persistPrefsQuiet() {
    try { localStorage.setItem(PREFS_STORE, JSON.stringify(prefs)); }
    catch (err) { /* storage disabled — in-memory state still applies this session */ }
}

// ── exported-preferences status ──
// data/preferences.json is the snapshot the Monday generate_prospekt.py reads.
// It is gitignored (stays local), so it can be missing or lag behind the live
// localStorage prefs. Surface that on the page so you know to re-export.
let exportChecked = false;   // has the initial fetch finished? (avoid flicker)
let exportPresent = false;   // does data/preferences.json exist?
let exportedAt = null;       // its updatedAt stamp, or null if unknown

async function checkExportStatus() {
    try {
        const res = await fetch('data/preferences.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        exportPresent = true;
        exportedAt = (data && typeof data.updatedAt === 'string') ? data.updatedAt : null;
    } catch (e) {
        exportPresent = false;
        exportedAt = null;
    }
    exportChecked = true;
    paintExportStatus();
}

function paintExportStatus() {
    const el = document.getElementById('steer-status');
    if (!el) return;
    el.classList.remove('ok', 'warn');
    if (!exportChecked) { el.textContent = ''; return; }   // not known yet
    const live = (prefs && typeof prefs.updatedAt === 'string') ? prefs.updatedAt : null;
    if (!exportPresent) {
        el.classList.add('warn');
        el.textContent = '⚠ Noch nicht exportiert — die Montags-Empfehlungen nutzen aktuell nur den Standard-Fokus. Exportiere deine Vorlieben.';
        return;
    }
    // Both files present: compare stamps. ISO-8601 UTC strings (toISOString)
    // compare correctly lexicographically.
    if (live && (!exportedAt || live > exportedAt)) {
        el.classList.add('warn');
        el.textContent = `⚠ Vorlieben seit dem letzten Export geändert${exportedAt ? ` (Export: ${formatStamp(exportedAt)})` : ''} — neu exportieren, damit Montag die aktuellen genutzt werden.`;
        return;
    }
    el.classList.add('ok');
    el.textContent = `✓ Exportierte Vorlieben aktuell${exportedAt ? ` (Stand ${formatStamp(exportedAt)})` : ''}.`;
}

function formatStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function interestLevel(key) {
    const v = prefs && prefs.interests ? prefs.interests[key] : 0;
    // Only trust levels we know how to weigh; a corrupt/hand-edited prefs file
    // with an out-of-range level must not crash scoreOffer().
    return (Number.isInteger(v) && LEVELS[String(v)]) ? v : 0;
}

// Votes are keyed by the stable offer id (titles are neither unique — the data
// has real duplicates — nor always present). The title is stored alongside so
// the export stays human-readable for generate_prospekt.py.
function voteFor(o) {
    const e = (prefs && prefs.votes && o) ? prefs.votes[o.id] : null;
    return e && (e.v === 1 || e.v === -1) ? e.v : 0;
}

// "Bought" is a loyalty signal: set by the 🛒 marker on cards and, at Monday
// time, by receipt OCR (scripts/ingest_receipt.py). Keyed by stable offer id
// like votes; `c` aggregates repeat buys so the generator can weight regulars.
function boughtFor(o) {
    const e = (prefs && prefs.bought && o) ? prefs.bought[o.id] : null;
    return e && Number.isFinite(e.c) ? e.c : 0;
}

function toggleBought(o) {
    const id = o && o.id;
    if (id == null) return;
    if (boughtFor(o) > 0) { delete prefs.bought[id]; }
    else { prefs.bought[id] = { c: 1, t: o.title || '' }; }
    savePrefs();
    renderAll();
}

// An offer's relevance = matching interest weights + the explicit vote + a
// small nudge for items the reader actually buys.
function scoreOffer(o) {
    let s = 0;
    for (const t of TOPICS) {
        if (t.test(o)) s += LEVELS[String(interestLevel(t.key))].weight;
    }
    s += voteFor(o) * VOTE_WEIGHT;
    if (boughtFor(o) > 0) s += BOUGHT_WEIGHT;
    return s;
}

// ── data loading ──
async function init() {
    loadPrefs();
    buildSteering();
    checkExportStatus();   // fire-and-forget: reports if data/preferences.json is missing/stale

    const weekSelect = document.getElementById('week-select');
    let files = [];
    try {
        files = await fetchJSON('data/folder-structure.json');
    } catch (err) {
        showError('Wochenliste konnte nicht geladen werden. Bitte Seite neu laden.');
        return;
    }
    files.sort((a, b) => fileDate(b).localeCompare(fileDate(a)));   // newest first
    files.forEach(file => {
        const m = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
        // Skip non-week artifacts (e.g. insights.json) so they can't become a
        // junk dropdown option that errors on selection.
        if (!m) return;
        const opt = document.createElement('option');
        opt.value = file;
        // Year from the filename (m[3]), not the folder (m[1]): they differ at
        // the ISO-week/year boundary.
        opt.textContent = `${m[2]} — ${m[5]}.${m[4]}.${m[3]}`;
        weekSelect.appendChild(opt);
    });
    weekSelect.addEventListener('change', () => {
        loadWeek(weekSelect.value);
    });

    await Promise.all([loadProspekt(), loadMealplan(), loadPriceHistory(), checkDevServer()]);
    if (files.length > 0) {
        await loadWeek(files[0]);
    } else {
        showError('Keine Wochendaten gefunden.');
    }
}

async function loadWeek(filePath) {
    try {
        const data = await fetchJSON(`data/${filePath}`);
        currentOffers = Array.isArray(data.offers) ? data.offers : [];
        const info = document.getElementById('info-bar');
        if (info) {
            info.textContent = data.totalCount
                ? `${data.totalCount} Angebote vom ${formatDate(data.validFrom)} bis ${formatDate(data.validTill)}`
                : '';
        }
    } catch (err) {
        currentOffers = [];
        showError('Angebote dieser Woche konnten nicht geladen werden.');
    }
    backfillVoteCategories();      // enrich votes with `c` before reconcile uses it
    reconcileOffCategoryVotes();
    renderAll();
}

// Optional AI editorial. Additive: absence never breaks the page.
async function loadProspekt() {
    try {
        // no-store: the editorial is regenerated weekly (and on demand); a
        // cached copy would keep showing last week's lead/picks after a refresh.
        const res = await fetch('data/prospekt.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        prospektData = await res.json();
    } catch (err) {
        prospektData = null;
    }
}

// Optional vegan week plan. Additive: absence just hides the meal-plan section.
async function loadMealplan() {
    try {
        // no-store like prospekt.json: a fresh plan (incl. the local "↻ Neu
        // generieren" rebuild) must show up without a hard refresh.
        const res = await fetch('data/mealplan.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        mealplanData = await res.json();
    } catch (err) {
        mealplanData = null;
    }
    buildMealplanView();
}

// Build the mutable working copy the page renders & swaps against. Keeps the
// raw mealplanData intact (re-derived on every (re)load / regenerate).
function buildMealplanView() {
    if (!mealplanData || !Array.isArray(mealplanData.days)) { mealplanView = null; return; }
    const days = mealplanData.days
        .filter(d => d && d.meal && d.meal.slug)
        .map(d => ({ day: d.day, meal: d.meal }));
    const bench = Array.isArray(mealplanData.bench) ? mealplanData.bench.filter(m => m && m.slug) : [];
    mealplanView = days.length ? { days, bench } : null;
}

// Optional cross-week price history. Additive: absence -> no price badges.
async function loadPriceHistory() {
    try {
        priceHistory = await fetchJSON('data/price-history-index.json');
        phByKey = new Map();
        (priceHistory.products || []).forEach(p => { if (p && p.key) phByKey.set(p.key, p); });
    } catch (err) {
        priceHistory = null;
        phByKey = null;
    }
}

function showError(msg) {
    const info = document.getElementById('info-bar');
    if (info) info.textContent = msg;
}

// ── steering tool (interest chips + export) ──
function buildSteering() {
    const wrap = document.getElementById('steer-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    TOPICS.forEach(t => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'steer-chip';
        chip.dataset.key = t.key;
        chip.addEventListener('click', () => cycleInterest(t.key));
        wrap.appendChild(chip);
    });
    paintChips();

    const exportBtn = document.getElementById('steer-export');
    if (exportBtn) exportBtn.addEventListener('click', exportPrefs);
    const resetBtn = document.getElementById('steer-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetPrefs);
    const regenBtn = document.getElementById('pk-mealplan-regen');
    if (regenBtn) regenBtn.addEventListener('click', regenerateMealplan);

    // Gluten-free toggle (meal plan): a pure client-side display swap, so it
    // works everywhere (not gated on the dev server) and needs no regeneration.
    // Persisted quietly — it never triggers a "re-export" prompt.
    const gfToggle = document.getElementById('pk-mealplan-gf');
    if (gfToggle) {
        gfToggle.checked = !!(prefs && prefs.glutenFree);
        syncGfToggle(gfToggle.checked);
        gfToggle.addEventListener('change', () => {
            if (prefs) { prefs.glutenFree = gfToggle.checked; persistPrefsQuiet(); }
            syncGfToggle(gfToggle.checked);
            renderMealplan();
        });
    }

    const slCopy = document.getElementById('pk-shopping-copy');
    if (slCopy) slCopy.addEventListener('click', copyShoppingList);
    const slSave = document.getElementById('pk-shopping-save');
    if (slSave) slSave.addEventListener('click', saveShoppingList);
    const slAdd = document.getElementById('pk-shopping-add');
    if (slAdd) slAdd.addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = document.getElementById('pk-shopping-add-input');
        if (inp) { addCustomItem(inp.value); inp.value = ''; inp.focus(); }
    });

    const hiddenToggle = document.getElementById('show-hidden');
    if (hiddenToggle) hiddenToggle.addEventListener('change', renderAll);

    // "Alle Angebote" browser — the anti-drift surface (see buildBrowseRow).
    const browseToggle = document.getElementById('browse-toggle');
    const browseBody = document.getElementById('browse-body');
    if (browseToggle && browseBody) {
        browseToggle.addEventListener('click', () => {
            const opening = browseBody.hidden;
            browseBody.hidden = !opening;
            browseToggle.setAttribute('aria-expanded', String(opening));
            renderBrowse();
        });
    }
    const browseSearch = document.getElementById('browse-search');
    if (browseSearch) browseSearch.addEventListener('input', () => {
        browseFilter = browseSearch.value;
        renderBrowse();
    });
}

// ── anti-drift "Alle Angebote" browser ──
// Once a topic is muted or a product down-voted it drops out of every section
// (score < 0). This browser lists the FULL week — hidden items included — so a
// single 👍 (vote weight 6, see VOTE_WEIGHT) pulls a wrongly-excluded product
// straight back into the curated lists. Prevents the filter bubble from drifting.
let browseFilter = '';

function buildBrowseRow(o) {
    const li = document.createElement('li');
    li.className = 'browse-row';
    const hidden = scoreOffer(o) < 0;
    if (hidden) li.classList.add('is-hidden');

    const main = document.createElement('div');
    main.className = 'browse-main';
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = CATEGORY_COLORS[catName(o)] || '#888';
    main.appendChild(dot);
    // Small product thumbnail (local archive first, live URL as fallback) so the
    // overview is scannable by picture, not just title. Absent image -> dot only.
    const thumb = buildOfferImage(o);
    if (thumb) {
        thumb.className = 'browse-thumb';
        main.appendChild(thumb);
    }
    const title = document.createElement('span');
    title.className = 'browse-title';
    title.textContent = o.title || '(ohne Titel)';
    title.title = o.title || '';
    main.appendChild(title);
    if (hidden) {
        const tag = document.createElement('span');
        tag.className = 'browse-tag';
        tag.textContent = 'ausgeblendet';
        main.appendChild(tag);
    }
    li.appendChild(main);

    const pr = offerPrice(o);
    const price = document.createElement('span');
    price.className = 'browse-price';
    price.textContent = pr === null ? '' : formatEuro(pr);
    li.appendChild(price);

    const vote = voteFor(o);
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'browse-vote up' + (vote === 1 ? ' on' : '');
    up.textContent = '👍';
    up.title = 'Zurückholen / mehr davon';
    up.setAttribute('aria-label', 'Zurückholen: ' + (o.title || ''));
    up.addEventListener('click', () => setVote(o, 1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'browse-vote down' + (vote === -1 ? ' on' : '');
    down.textContent = '🚫';
    down.title = 'Ausblenden';
    down.setAttribute('aria-label', 'Ausblenden: ' + (o.title || ''));
    down.addEventListener('click', () => setVote(o, -1));
    li.appendChild(up);
    li.appendChild(down);
    return li;
}

function renderBrowse() {
    const list = document.getElementById('browse-list');
    const body = document.getElementById('browse-body');
    if (!list) return;
    if (body && body.hidden) { list.innerHTML = ''; return; }   // skip work while collapsed

    const q = browseFilter.trim().toLowerCase();
    let items = currentOffers.slice();
    if (q) {
        items = items.filter(o =>
            (o.title || '').toLowerCase().includes(q) || catName(o).toLowerCase().includes(q));
    }
    // Still-shown items first, the ausgeblendeten (score < 0) sink to the bottom;
    // alphabetical within each group.
    items.sort((a, b) => {
        const ha = scoreOffer(a) < 0, hb = scoreOffer(b) < 0;
        if (ha !== hb) return ha ? 1 : -1;
        return String(a.title || '').localeCompare(String(b.title || ''));
    });

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.forEach(o => frag.appendChild(buildBrowseRow(o)));
    list.appendChild(frag);
}

function updateHiddenCount() {
    const n = currentOffers.reduce((c, o) => c + (scoreOffer(o) < 0 ? 1 : 0), 0);
    const el = document.getElementById('hidden-count');
    if (el) el.textContent = n ? `${n} ausgeblendet` : '';
    const bc = document.getElementById('browse-count');
    if (bc) bc.textContent = `${currentOffers.length} Angebote${n ? ` · ${n} ausgeblendet` : ''}`;
}

function paintChips() {
    const wrap = document.getElementById('steer-chips');
    if (!wrap) return;
    Array.from(wrap.children).forEach(chip => {
        const key = chip.dataset.key;
        const t = TOPICS.find(x => x.key === key);
        if (!t) return;
        const lvl = interestLevel(key);
        const meta = LEVELS[String(lvl)];
        chip.className = 'steer-chip ' + meta.cls;
        chip.title = `${t.label}: ${meta.label} (klicken zum Ändern)`;
        chip.setAttribute('aria-label', `${t.label}: ${meta.label}`);
        chip.textContent = '';
        const em = document.createElement('span');
        em.className = 'chip-emoji';
        em.textContent = t.emoji;
        chip.appendChild(em);
        chip.appendChild(document.createTextNode(t.label));
        const tag = document.createElement('span');
        tag.className = 'chip-state';
        tag.textContent = lvl === 0 ? '' : meta.label;
        chip.appendChild(tag);
    });
}

function cycleInterest(key) {
    const cur = interestLevel(key);
    const next = LEVEL_CYCLE[(LEVEL_CYCLE.indexOf(cur) + 1) % LEVEL_CYCLE.length];
    prefs.interests[key] = next;
    // Switching a category OFF makes its per-item 👎 redundant — the category
    // already suppresses them. Drop those (keep 👍 as deliberate exceptions).
    const pruned = next === -1 ? pruneDownVotesForCategory(key) : 0;
    savePrefs();
    paintChips();
    renderAll();
    if (pruned > 0) {
        const hint = document.getElementById('steer-hint');
        const t = TOPICS.find(x => x.key === key);
        const label = t ? t.label : key;
        if (hint) {
            hint.textContent = `${pruned} ${pruned === 1 ? 'Bewertung' : 'Bewertungen'} aus „${label}“ entfernt — die Kategorie steuert das jetzt.`;
        }
    }
}

// Drop the redundant 👎 votes inside a switched-off category, keeping 👍 votes
// (deliberate "category off, but THIS one yes" exceptions). Returns the count
// removed. Only category-based topics qualify; for others this is a no-op.
// A vote's category comes from its stored `c`; older exports without it are
// resolved against this week's loaded offers by id (cross-week votes that no
// longer appear this week can't be classified and are left untouched).
function pruneDownVotesForCategory(topicKey) {
    const cat = CATEGORY_FOR_TOPIC[topicKey];
    if (!cat || !prefs || !prefs.votes) return 0;
    const catById = new Map(currentOffers.map(o => [String(o.id), catName(o)]));
    let removed = 0;
    for (const [id, e] of Object.entries(prefs.votes)) {
        if (!e || e.v !== -1) continue;          // keep 👍 exceptions
        const voteCat = e.c || catById.get(String(id));
        if (voteCat === cat) { delete prefs.votes[id]; removed++; }
    }
    return removed;
}

// Backfill the category (`c`) on votes stored before votes carried it, resolving
// each against the loaded week by id. Pure frontend metadata for robust
// cross-week pruning — the generator never reads it and it does not change the
// reader's actual choices, so it persists QUIETLY (no updatedAt bump, hence no
// spurious "re-export" prompt). Votes whose id is absent from this week are left
// untouched until a week that contains them is loaded.
function backfillVoteCategories() {
    if (!prefs || !prefs.votes || !currentOffers.length) return;
    const catById = new Map(currentOffers.map(o => [String(o.id), catName(o)]));
    let changed = false;
    for (const [id, e] of Object.entries(prefs.votes)) {
        if (!e || e.c) continue;
        const cat = catById.get(String(id));
        if (cat) { e.c = cat; changed = true; }
    }
    if (changed) {
        try { localStorage.setItem(PREFS_STORE, JSON.stringify(prefs)); }
        catch (err) { /* storage disabled — in-memory enrichment still helps this session */ }
    }
}

// Self-heal already-stored prefs: a category may have been switched off BEFORE
// the auto-prune existed, leaving its redundant 👎 in the file. Run once after a
// week loads (offers available for resolving pre-`c` votes). Idempotent — once
// pruned it removes nothing, so re-running on every loadWeek is harmless.
function reconcileOffCategoryVotes() {
    if (!prefs || !prefs.interests) return;
    let removed = 0;
    for (const key of Object.keys(CATEGORY_FOR_TOPIC)) {
        if (interestLevel(key) === -1) removed += pruneDownVotesForCategory(key);
    }
    if (removed > 0) {
        savePrefs();
        const hint = document.getElementById('steer-hint');
        if (hint) {
            hint.textContent = `${removed} überflüssige Bewertung${removed === 1 ? '' : 'en'} in ausgeschalteten Kategorien bereinigt — bitte neu exportieren.`;
        }
    }
}

function setVote(o, value) {
    const id = o && o.id;
    if (id == null) return;
    const cur = voteFor(o);
    if (cur === value) {
        delete prefs.votes[id];        // second click on the same thumb clears it
    } else {
        prefs.votes[id] = { v: value, t: o.title || '', c: catName(o) };
    }
    savePrefs();
    renderAll();
}

async function exportPrefs() {
    const payload = JSON.stringify(prefs, null, 2) + '\n';
    const hint = document.getElementById('steer-hint');
    // Prefer the local dev server (scripts/serve.py): it writes straight into
    // data/preferences.json, so there's nothing to move by hand. If that server
    // isn't running (plain http.server, file://, or a fetch error), fall back to
    // a normal download.
    try {
        const res = await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        });
        if (res.ok) {
            if (hint) hint.textContent = 'In data/preferences.json gespeichert — am Montag generate_prospekt.py ausführen.';
            checkExportStatus();   // re-read the file so the status flips to "aktuell"
            return;
        }
    } catch (e) {
        // No local save server reachable — fall through to download.
    }
    downloadPrefs(payload, hint);
}

function downloadPrefs(payload, hint) {
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preferences.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (hint) hint.textContent = 'preferences.json heruntergeladen — leg sie in data/ ab (oder starte scripts/serve.py für direktes Speichern) und führ am Montag generate_prospekt.py aus.';
}

function resetPrefs() {
    prefs = defaultPrefs();
    savePrefs();
    paintChips();
    renderAll();
    const hint = document.getElementById('steer-hint');
    if (hint) hint.textContent = 'Vorlieben zurückgesetzt.';
}

// ── price check: is this week's Grundpreis a genuine deal vs the product's
// own history? Joins the offer to data/price-history-index.json via the same
// composite key build_indexes.py uses, then mirrors the dashboard's
// percentile / "über Tief" logic. Returns {tier,text,title} or null.
const PC_EPS = 1e-9;

function selectedWeekDate() {
    const sel = document.getElementById('week-select');
    const d = sel ? fileDate(sel.value) : '';
    return d || (priceHistory && priceHistory.latestDate) || '';
}

function priceCheck(o) {
    if (!phByKey) return null;
    const gp = parseGp(o);
    if (gp.val === null || gp.flag !== 'exact') return null;   // need an unambiguous €/unit
    const prod = phByKey.get(productKey(o, gp.unit));
    if (!prod || !Array.isArray(prod.obs)) return null;

    const date = selectedWeekDate();
    // One exact Grundpreis per distinct PRIOR week (min), like dashboard.js
    // precomputeHistory — strictly earlier weeks form the comparison history.
    const perWeek = new Map();
    for (const ob of prod.obs) {
        if (ob.gpf !== undefined) continue;        // exclude range / "ab €"
        if (!ob.d || ob.d >= date) continue;       // only weeks before the selected one
        const cur = perWeek.get(ob.d);
        perWeek.set(ob.d, cur === undefined ? ob.gp : Math.min(cur, ob.gp));
    }
    const priorDates = [...perWeek.keys()].sort();
    if (priorDates.length < 2) return null;        // not enough history to judge

    const cur = gp.val;
    const priorVals = priorDates.map(d => perWeek.get(d));
    const min = Math.min(...priorVals);
    const over = min > 0 ? (cur / min - 1) : 0;
    const pctOver = Math.round(over * 100);
    const depth = `Tief €${min.toFixed(2)}/${gp.unit} · ${priorVals.length} Vergleichswochen`;

    if (cur <= min + PC_EPS) {
        // At or below everything seen before — how long was it pricier than now?
        let run = 0;
        for (let i = priorDates.length - 1; i >= 0; i--) {
            if (perWeek.get(priorDates[i]) > cur + PC_EPS) run++; else break;
        }
        return { tier: 'best', text: run >= 2 ? `Bestpreis seit ${run} Wochen` : 'Bestpreis', title: depth };
    }
    if (pctOver <= 10) return { tier: 'good', text: 'Guter Preis', title: `+${pctOver}% über ${depth}` };
    if (pctOver >= 20) return { tier: 'wait', text: `+${pctOver}% über Tief`, title: `schon mal günstiger — ${depth}` };
    return null;   // 11–19% over: unremarkable, keep the card clean
}

// ── rendering ──
function pickReason(title) {
    if (!prospektData) return '';
    // Prefer the new ranked foryou[]; fall back to the legacy picks[] alias.
    for (const list of [prospektData.foryou, prospektData.picks]) {
        if (!Array.isArray(list)) continue;
        const hit = list.find(p => p && p.title === title);
        if (hit && typeof hit.reason === 'string' && hit.reason) return hit.reason;
    }
    return '';
}

function buildCard(o, opts) {
    opts = opts || {};
    const card = document.createElement('article');
    card.className = 'pk-card';
    const vote = voteFor(o);
    if (vote === -1) card.classList.add('downvoted');

    const thumb = document.createElement('div');
    thumb.className = 'pk-thumb';
    const img = buildOfferImage(o);
    if (img) {
        thumb.appendChild(img);
    } else {
        thumb.classList.add('noimg');
        thumb.textContent = '🛒';
    }
    if (isKnuller(o)) {
        const badge = document.createElement('span');
        badge.className = 'knuller-badge';
        badge.textContent = 'Knüller';
        thumb.appendChild(badge);
    }
    if (boughtFor(o) > 0) {
        const b = document.createElement('span');
        b.className = 'bought-badge';
        b.textContent = '✓ gekauft';
        thumb.appendChild(b);
    }
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'pk-body';

    if (opts.tag) {
        const tag = document.createElement('div');
        tag.className = 'pk-tag';
        tag.textContent = opts.tag;
        body.appendChild(tag);
    }

    const title = document.createElement('div');
    title.className = 'pk-title';
    title.title = o.title || '';
    title.textContent = o.title || '(ohne Titel)';
    body.appendChild(title);

    const catLine = document.createElement('div');
    catLine.className = 'pk-cat';
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = CATEGORY_COLORS[catName(o)] || '#888';
    catLine.appendChild(dot);
    catLine.appendChild(document.createTextNode(catName(o) || '—'));
    body.appendChild(catLine);

    const priceRow = document.createElement('div');
    priceRow.className = 'pk-price-row';
    const price = document.createElement('span');
    price.className = 'pk-price';
    const pr = offerPrice(o);
    price.textContent = pr === null ? '—' : formatEuro(pr);
    priceRow.appendChild(price);
    if (typeof o.basicPrice === 'string' && o.basicPrice.trim()) {
        const gp = document.createElement('span');
        gp.className = 'pk-gp';
        gp.textContent = o.basicPrice;
        priceRow.appendChild(gp);
    }
    body.appendChild(priceRow);

    const pc = priceCheck(o);
    if (pc) {
        const badge = document.createElement('div');
        badge.className = 'pk-pricecheck pc-' + pc.tier;
        badge.textContent = pc.text;
        if (pc.title) badge.title = pc.title;
        body.appendChild(badge);
    }

    const reason = pickReason(o.title || '');
    if (reason) {
        const r = document.createElement('div');
        r.className = 'pk-reason';
        r.textContent = '💡 ' + reason;
        body.appendChild(r);
    }

    const actions = document.createElement('div');
    actions.className = 'pk-actions';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'pk-vote up' + (vote === 1 ? ' on' : '');
    up.textContent = '👍';
    up.setAttribute('aria-label', 'Mehr davon');
    up.addEventListener('click', () => setVote(o, 1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'pk-vote down' + (vote === -1 ? ' on' : '');
    down.textContent = '🚫';
    down.setAttribute('aria-label', 'Weniger davon');
    down.addEventListener('click', () => setVote(o, -1));
    const buy = document.createElement('button');
    buy.type = 'button';
    buy.className = 'pk-vote buy' + (boughtFor(o) > 0 ? ' on' : '');
    buy.textContent = '🛒';
    buy.title = boughtFor(o) > 0 ? 'Als gekauft markiert (klick zum Entfernen)' : 'Schon gekauft (Loyalität)';
    buy.setAttribute('aria-label', 'Als gekauft markieren');
    buy.addEventListener('click', () => toggleBought(o));
    const basket = document.createElement('button');
    basket.type = 'button';
    basket.className = 'pk-vote basket' + (basketHas(o) ? ' on' : '');
    basket.textContent = '🧺';
    basket.title = basketHas(o) ? 'Auf dem Einkaufszettel (klick zum Entfernen)' : 'Auf den Einkaufszettel';
    basket.setAttribute('aria-label', 'Auf den Einkaufszettel');
    basket.addEventListener('click', () => toggleBasket(o));
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(buy);
    actions.appendChild(basket);
    body.appendChild(actions);

    card.appendChild(body);
    return card;
}

// Fill one section grid; returns how many cards were rendered.
function fillSection(gridId, introId, offers, sectionKey, opts) {
    opts = opts || {};
    const grid = document.getElementById(gridId);
    const section = grid ? grid.closest('.pk-section') : null;
    if (!grid) return 0;
    grid.innerHTML = '';

    const showHidden = document.getElementById('show-hidden');
    const includeHidden = showHidden && showHidden.checked;

    // Sections keep neutral items too (score >= 0); only muted topics or
    // down-voted products (score < 0) drop out unless "Ausgeblendete zeigen".
    let list = offers
        .map(o => ({ o, s: scoreOffer(o) }))
        .filter(x => includeHidden || x.s >= 0)
        .sort((a, b) => b.s - a.s || String(a.o.title || '').localeCompare(String(b.o.title || '')));
    if (opts.limit) list = list.slice(0, opts.limit);

    list.forEach(x => grid.appendChild(buildCard(x.o)));

    const intro = introId ? document.getElementById(introId) : null;
    if (intro) {
        const txt = prospektData && prospektData.sections ? prospektData.sections[sectionKey] : '';
        intro.textContent = typeof txt === 'string' ? txt : '';
        intro.style.display = txt ? '' : 'none';
    }
    if (section) section.style.display = list.length ? '' : 'none';
    return list.length;
}

function renderHero() {
    const lead = document.getElementById('pk-lead');
    const sub = document.getElementById('pk-week');
    if (sub) {
        const wl = prospektData && prospektData.weekLabel;
        sub.textContent = wl ? `Unsere Highlights für ${wl}` : 'Unsere Highlights der Woche';
    }
    if (lead) {
        const txt = prospektData && typeof prospektData.lead === 'string' ? prospektData.lead : '';
        lead.textContent = txt || 'Handverlesene Angebote der Woche — vegan, frisch, mit kühlem Bier und Spezi. Sag uns mit 👍 / 🚫 und den Vorlieben weiter unten, was dich interessiert.';
    }
}

// Filter helper for the topic sections; a throwing test (bad data) drops the
// offer rather than breaking the whole render. Sections may overlap — a product
// can appear both in "Für dich" and in its topic section, which is intended.
function offersWhere(test) {
    return currentOffers.filter(o => { try { return test(o); } catch (e) { return false; } });
}

// "Für dich": the LLM's ranked order (data/prospekt.json foryou[]) when
// present, with LIVE client prefs overriding Monday's snapshot — an item the
// reader has since muted or down-voted (score < 0) is dropped, fresh up-votes
// are backfilled from the client-side score. Without prospekt.json it is purely
// the client-side score (the original behaviour). Returns the offers plus the
// set already placed, so discoveries don't duplicate them.
function buildForYou() {
    const inForYou = new Set();
    const list = [];
    const llm = prospektData && Array.isArray(prospektData.foryou) ? prospektData.foryou : null;
    if (llm) {
        const ordered = llm.slice().sort((a, b) => ((a && a.rank) || 99) - ((b && b.rank) || 99));
        for (const entry of ordered) {
            if (!entry || !entry.title) continue;
            const o = currentOffers.find(x => (x.title || '') === entry.title && !inForYou.has(x));
            if (!o || scoreOffer(o) < 0) continue;     // muted/down-voted since Monday -> drop
            inForYou.add(o); list.push(o);
            if (list.length >= FORYOU_MAX) break;
        }
    }
    if (list.length < FORYOU_MAX) {
        currentOffers
            .filter(o => !inForYou.has(o))
            .map(o => ({ o, s: scoreOffer(o) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s || String(a.o.title || '').localeCompare(String(b.o.title || '')))
            .forEach(x => { if (list.length < FORYOU_MAX) { inForYou.add(x.o); list.push(x.o); } });
    }
    return { list, inForYou };
}

// 1-2 genuine price deals OUTSIDE the reader's stated interests (neutral
// topics, score === 0), surfaced as "Entdeckung" so a narrow profile doesn't
// hide a real bargain. Respects explicit mutes (score < 0) and down-votes.
function pickDiscoveries(inForYou, limit) {
    const found = [];
    for (const o of currentOffers) {
        if (inForYou.has(o)) continue;
        if (scoreOffer(o) !== 0) continue;          // only truly-neutral items
        if (voteFor(o) === -1) continue;
        const pc = priceCheck(o);
        if (!pc || (pc.tier !== 'best' && pc.tier !== 'good')) continue;
        found.push({ o, best: pc.tier === 'best' });
    }
    found.sort((a, b) => (b.best ? 1 : 0) - (a.best ? 1 : 0));
    return found.slice(0, limit).map(x => x.o);
}

// ── meal plan (vegan week) ──
// Probe scripts/serve.py's health endpoint. A plain `python3 -m http.server`
// (the other documented local option) answers /api/health with 404, so this
// cleanly tells the dev server with the write endpoints apart from one without —
// gating "↻ Neu generieren" on hostname alone would show it on http.server and a
// click would trigger a spurious preferences download + a failed regen.
async function checkDevServer() {
    try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        localApi = res.ok;
    } catch (e) {
        localApi = false;
    }
}

// Per-meal votes are keyed by the meal slug (stable across weeks, so a
// recurring dish keeps its rating). Stored under prefs.meals; exported to
// data/preferences.json and read back by generate_mealplan.py next run.
function mealVoteFor(slug) {
    const e = (prefs && prefs.meals && slug) ? prefs.meals[slug] : null;
    return e && (e.v === 1 || e.v === -1) ? e.v : 0;
}

function setMealVote(meal, value) {
    if (!meal || !meal.slug || !prefs) return;
    if (!prefs.meals) prefs.meals = {};
    const slug = meal.slug;
    if (mealVoteFor(slug) === value) {
        delete prefs.meals[slug];        // second click on the same thumb clears it
    } else {
        prefs.meals[slug] = { v: value, t: meal.title || '', tags: Array.isArray(meal.tags) ? meal.tags : [] };
    }
    savePrefs();
    renderMealplan();
    paintExportStatus();   // the meal vote may now outdate the export
}

// Swap a day's meal for the next bench alternative (the swapped-out meal goes
// back onto the bench). Purely visual — does not touch prefs.
function swapMeal(dayIndex) {
    if (!mealplanView || !mealplanView.bench.length) return;
    const cur = mealplanView.days[dayIndex];
    if (!cur) return;
    const next = mealplanView.bench.shift();
    mealplanView.bench.push(cur.meal);
    cur.meal = next;
    renderMealplan();
}

// Gluten-free substitutions for the meal plan. When prefs.glutenFree is on the
// toggle rewrites gluten-bearing ingredient names and step text to GF
// alternatives — pasta, flour, couscous, bulgur, seitan, soy sauce, bread, oats.
// Single regex over the ORIGINAL string (matches replaced once, never rescanned)
// so "Nudeln" -> "glutenfreie Nudeln" can't double-substitute. Specific compounds
// listed before generic words; \b stops it matching inside other words (e.g.
// "Maisgrieß", "Sojadrink" stay untouched). Render-time only -> instant & reversible.
const GF_RULES = [
    { re: /\bVollkornnudeln\b/i, to: 'glutenfreie Nudeln' },
    { re: /\bBandnudeln\b/i,     to: 'glutenfreie Bandnudeln' },
    { re: /\bNudeln\b/i,         to: 'glutenfreie Nudeln' },
    { re: /\bSpaghetti\b/i,      to: 'glutenfreie Spaghetti' },
    { re: /\bTagliatelle\b/i,    to: 'glutenfreie Tagliatelle' },
    { re: /\bPenne\b/i,          to: 'glutenfreie Penne' },
    { re: /\bPasta\b/i,          to: 'glutenfreie Pasta' },
    { re: /\bWeizenmehl\b/i,     to: 'glutenfreies Mehl' },
    { re: /\bMehl\b/i,           to: 'glutenfreies Mehl' },
    { re: /\bCouscous\b/i,       to: 'Quinoa' },
    { re: /\bBulgur\b/i,         to: 'Quinoa' },
    { re: /\bSeitan\b/i,         to: 'Tofu' },
    // Trailing \b is unreliable after "ß" (ß ∉ \w in JS), so assert "no letter
    // follows" instead — still keeps "Maisgrieß"/"Grießbrei" untouched.
    { re: /\bGrie(?:ss|ß)(?![\wäöüÄÖÜß])/i, to: 'Polenta' },
    { re: /\bSoja(?:so(?:ß|ss)e|sauce)\b/i, to: 'Tamari (glutenfrei)' },
    { re: /\bBrötchen\b/i,       to: 'glutenfreie Brötchen' },
    { re: /\bBaguette\b/i,       to: 'glutenfreies Baguette' },
    { re: /\bBrot\b/i,           to: 'glutenfreies Brot' },
    { re: /\bToast\b/i,          to: 'glutenfreier Toast' },
    { re: /\bHaferflocken\b/i,   to: 'glutenfreie Haferflocken' },
    { re: /\bTortillas?\b/i,     to: 'Mais-Tortillas' },
    { re: /\bWraps?\b/i,         to: 'Mais-Wraps' },
];
const GF_RE = new RegExp(GF_RULES.map(r => r.re.source).join('|'), 'gi');

function glutenFreeText(s) {
    return String(s == null ? '' : s).replace(GF_RE, m => {
        for (const r of GF_RULES) if (r.re.test(m)) return r.to;
        return m;
    });
}

// Reflect the GF toggle's on/off state on its pill label (visual only).
function syncGfToggle(on) {
    const label = document.getElementById('pk-mealplan-gf-label');
    if (label) label.classList.toggle('on', !!on);
}

function buildMealCard(day, meal, dayIndex) {
    const card = document.createElement('article');
    card.className = 'mp-card';
    const vote = mealVoteFor(meal.slug);
    if (vote === -1) card.classList.add('downvoted');

    const dayEl = document.createElement('div');
    dayEl.className = 'mp-day';
    dayEl.textContent = WEEKDAYS_FULL[day] || day || '';
    card.appendChild(dayEl);

    const title = document.createElement('div');
    title.className = 'mp-title';
    title.textContent = meal.title || '(ohne Titel)';
    card.appendChild(title);

    if (meal.blurb) {
        const blurb = document.createElement('div');
        blurb.className = 'mp-blurb';
        blurb.textContent = meal.blurb;
        card.appendChild(blurb);
    }

    const gf = !!(prefs && prefs.glutenFree);
    const ings = document.createElement('div');
    ings.className = 'mp-ings';
    (Array.isArray(meal.ingredients) ? meal.ingredients : []).forEach(ing => {
        if (!ing || !ing.name) return;
        const chip = document.createElement('span');
        const swapped = gf ? glutenFreeText(ing.name) : ing.name;
        if (gf && swapped !== ing.name) {
            // Gluten ingredient replaced by a GF alternative. Drop any offer
            // link/price — the GF product is not the one that's on offer.
            chip.className = 'mp-chip gf';
            chip.textContent = swapped;
            chip.title = `glutenfrei statt „${ing.name}“`;
        } else if (ing.offerTitle) {
            const onOffer = currentOffers.some(o => (o.title || '') === ing.offerTitle);
            chip.className = 'mp-chip offer';
            chip.textContent = ing.name;
            if (ing.price) {
                const p = document.createElement('span');
                p.className = 'mp-chip-price';
                p.textContent = ing.price;
                chip.appendChild(p);
            }
            chip.title = onOffer ? `Im Angebot: ${ing.offerTitle}` : `${ing.offerTitle} (diese Woche nicht gefunden)`;
        } else {
            chip.className = 'mp-chip pantry';
            chip.textContent = ing.name;
            chip.title = 'Vorrat / bekanntes veganes Produkt';
        }
        ings.appendChild(chip);
    });
    card.appendChild(ings);

    if (Array.isArray(meal.steps) && meal.steps.length) {
        const details = document.createElement('details');
        details.className = 'mp-steps';
        const summary = document.createElement('summary');
        summary.textContent = 'Zubereitung';
        details.appendChild(summary);
        const ol = document.createElement('ol');
        meal.steps.forEach(s => {
            const li = document.createElement('li');
            li.textContent = gf ? glutenFreeText(s) : s;
            ol.appendChild(li);
        });
        details.appendChild(ol);
        card.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'mp-actions';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'mp-btn up' + (vote === 1 ? ' on' : '');
    up.textContent = '👍';
    up.setAttribute('aria-label', 'Gericht mag ich');
    up.addEventListener('click', () => setMealVote(meal, 1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'mp-btn down' + (vote === -1 ? ' on' : '');
    down.textContent = '🚫';
    down.setAttribute('aria-label', 'Gericht mag ich nicht');
    down.addEventListener('click', () => setMealVote(meal, -1));
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'mp-btn swap';
    swap.textContent = '↻ Tauschen';
    swap.setAttribute('aria-label', 'Anderes Gericht');
    swap.disabled = !(mealplanView && mealplanView.bench.length);
    swap.addEventListener('click', () => swapMeal(dayIndex));
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(swap);
    card.appendChild(actions);

    return card;
}

function renderMealplan() {
    const section = document.getElementById('pk-mealplan');
    const grid = document.getElementById('pk-mealplan-grid');
    if (!section || !grid) return;
    const regen = document.getElementById('pk-mealplan-regen');
    if (regen) regen.hidden = !localApi;
    const intro = document.getElementById('pk-mealplan-intro');
    const hasPlan = !!(mealplanView && mealplanView.days.length);

    // Hide the whole section only when there's nothing to show AND no way to make
    // one. On the dev server, keep it visible with an empty state so the first
    // plan can be generated straight from the "↻ Neu generieren" button.
    if (!hasPlan && !localApi) {
        section.style.display = 'none';
        renderShopping();   // marked offers can still fill the shopping list
        return;
    }
    section.style.display = '';

    if (intro) {
        const txt = hasPlan && mealplanData && typeof mealplanData.intro === 'string'
            ? mealplanData.intro
            : (hasPlan ? '' : 'Noch kein Wochenplan — „↻ Neu generieren" baut einen aus den aktuellen Angeboten und deinen Vorlieben.');
        intro.textContent = txt;
        intro.style.display = txt ? '' : 'none';
    }

    grid.innerHTML = '';
    if (hasPlan) {
        mealplanView.days.forEach((d, i) => grid.appendChild(buildMealCard(d.day, d.meal, i)));
    }
    renderShopping();   // keep the shopping list in sync with the shown plan
}

// Local-only: rebuild the plan live via scripts/serve.py (claude -p). Exports
// the current prefs first so the generator honours fresh meal votes. The button
// only shows when the dev API is reachable (localApi), so the exportPrefs POST
// here hits serve.py rather than falling back to a download.
async function regenerateMealplan() {
    const btn = document.getElementById('pk-mealplan-regen');
    const intro = document.getElementById('pk-mealplan-intro');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generiere…'; }
    try {
        await exportPrefs();   // persist fresh meal votes into data/preferences.json
        const res = await fetch('/api/mealplan/regenerate', { method: 'POST' });
        if (!res.ok) {
            let msg = `Fehler ${res.status}`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* non-JSON */ }
            throw new Error(msg);
        }
        await loadMealplan();
        renderMealplan();
    } catch (err) {
        if (intro) {
            intro.style.display = '';
            intro.textContent = 'Neu-Generierung fehlgeschlagen: ' + (err && err.message ? err.message : err);
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig || '↻ Neu generieren'; }
    }
}

// ── shopping list (curated, editable, saved on disk via serve.py) ──
// The list is its own thing, fed ONLY by the meal plan and the 🧺 gesture —
// NOT by 👍 (taste) or 🛒 (loyalty), which stay separate signals. Rows merge by
// normalised name into offers / pantry / own items; the reader can remove (×),
// check off, and type their own. Overlay state lives in prefs.basket and resets
// when the plan changes (new week or regeneration). Built fresh on each render.

// KW label + date of the selected week, parsed from the dropdown's file path
// (data/{YEAR}/KW{XX}/{DATE}.json). The date names the saved file server-side.
function selectedWeekMeta() {
    const sel = document.getElementById('week-select');
    const m = (sel ? sel.value : '').match(/(KW\d+)\/(\d{4}-\d{2}-\d{2})/);
    return { weekLabel: m ? m[1] : '', date: m ? m[2] : '' };
}

// Identity of the current plan: the list is bound to it, so a new week or a
// regenerated plan starts a fresh basket (matches "checked stays until the next
// plan"). Includes the meal plan's generatedAt so a live regen also resets.
function currentPlanKey() {
    const m = selectedWeekMeta();
    const gen = (mealplanData && typeof mealplanData.generatedAt === 'string') ? mealplanData.generatedAt : '';
    return `${m.weekLabel}|${m.date}|${gen}`;
}

function ensureBasketForPlan() {
    if (!prefs) return;
    if (!prefs.basket) prefs.basket = emptyBasket();
    const key = currentPlanKey();
    if (prefs.basket.planKey !== key) {
        prefs.basket = emptyBasket();
        prefs.basket.planKey = key;
        persistPrefsQuiet();
    }
}

// ── 🧺 membership (card gesture; separate from votes/bought) ──
function basketHas(o) {
    return !!(prefs && prefs.basket && o && o.id != null && prefs.basket.offers[o.id]);
}

function toggleBasket(o) {
    const id = o && o.id;
    if (id == null || !prefs) return;
    if (!prefs.basket) prefs.basket = emptyBasket();
    const b = prefs.basket;
    if (b.offers[id]) {
        delete b.offers[id];
    } else {
        b.offers[id] = { t: o.title || '', c: catName(o) };
        delete b.removed[normTitle(o.title || '')];   // un-hide if it had been ×'d
    }
    persistPrefsQuiet();
    renderAll();   // refresh the card button state and the list together
}

// Build the list rows by merging the plan, the 🧺 offers, and own items,
// applying the removed/checked overlay. Each row carries its origins so a ×
// can clean up the right source. Groups: offers (priced) / pantry / own.
function buildShoppingList() {
    ensureBasketForPlan();
    const b = prefs.basket;
    const gf = !!(prefs && prefs.glutenFree);
    const rows = new Map();   // normName -> row
    const RANK = { offer: 3, custom: 2, pantry: 1 };

    const ensureRow = (name, group) => {
        const nn = normTitle(name);
        if (!nn || b.removed[nn]) return null;
        let r = rows.get(nn);
        if (!r) {
            r = { name, price: '', checked: !!b.checked[nn], normName: nn, group, origins: { offerIds: [], customIds: [], plan: false } };
            rows.set(nn, r);
        } else if (RANK[group] > RANK[r.group]) {
            r.group = group;
        }
        return r;
    };

    // 1) meal-plan ingredients — mirror buildMealCard's offer/pantry/GF split.
    if (mealplanView && Array.isArray(mealplanView.days)) {
        mealplanView.days.forEach(d => {
            const meal = d && d.meal;
            (meal && Array.isArray(meal.ingredients) ? meal.ingredients : []).forEach(ing => {
                if (!ing || !ing.name) return;
                const swapped = gf ? glutenFreeText(ing.name) : ing.name;
                let group = 'pantry', price = '';
                if (gf && swapped !== ing.name) group = 'pantry';         // GF substitute (not on offer)
                else if (ing.offerTitle) { group = 'offer'; price = ing.price || ''; }
                const r = ensureRow(swapped, group);
                if (r) { r.origins.plan = true; if (price && !r.price) r.price = price; }
            });
        });
    }

    // 2) offers added with 🧺 — resolve against this week for a live price.
    Object.keys(b.offers).forEach(id => {
        const o = currentOffers.find(x => String(x.id) === String(id));
        const name = o ? (o.title || '') : (b.offers[id].t || '');
        const r = ensureRow(name, 'offer');
        if (!r) return;
        r.origins.offerIds.push(id);
        if (!r.price) {
            const pr = o ? offerPrice(o) : null;
            if (pr !== null) r.price = `€${pr.toFixed(2).replace('.', ',')}`;
        }
    });

    // 3) own typed-in items.
    (Array.isArray(b.custom) ? b.custom : []).forEach(c => {
        const r = ensureRow(c.name, 'custom');
        if (r) r.origins.customIds.push(c.id);
    });

    const byName = (a, b2) => a.name.localeCompare(b2.name, 'de');
    const titles = { offer: 'Angebote diese Woche', pantry: 'Vorrat & Basis', custom: 'Eigene Posten' };
    const groups = ['offer', 'pantry', 'custom']
        .map(k => ({ key: k, title: titles[k], items: [...rows.values()].filter(r => r.group === k).sort(byName) }))
        .filter(g => g.items.length);
    const meta = selectedWeekMeta();
    return { weekLabel: meta.weekLabel, date: meta.date, groups, total: rows.size };
}

// ── edits ──
// × a row: hide it (removed by name) and drop its 🧺/own sources so the card
// button and the typed list stay consistent.
function removeRow(row) {
    if (!prefs || !prefs.basket || !row) return;
    const b = prefs.basket;
    b.removed[row.normName] = true;
    row.origins.offerIds.forEach(id => { delete b.offers[id]; });
    if (row.origins.customIds.length) {
        const drop = new Set(row.origins.customIds.map(String));
        b.custom = b.custom.filter(c => !drop.has(String(c.id)));
    }
    persistPrefsQuiet();
    renderAll();   // a removed 🧺 offer must also un-light its card button
}

function toggleChecked(normName) {
    if (!prefs || !prefs.basket || !normName) return;
    const b = prefs.basket;
    if (b.checked[normName]) delete b.checked[normName];
    else b.checked[normName] = true;
    persistPrefsQuiet();
    renderShopping();
}

function addCustomItem(name) {
    name = (name || '').trim();
    if (!name || !prefs) return;
    if (!prefs.basket) prefs.basket = emptyBasket();
    const b = prefs.basket;
    const nn = normTitle(name);
    delete b.removed[nn];   // typing it back un-removes it
    if (!b.custom.some(c => normTitle(c.name) === nn)) {
        b.custom.push({ id: 'c' + Date.now().toString(36), name });
    }
    persistPrefsQuiet();
    renderShopping();
}

// Plain-text render — a Markdown-style checklist, ready to paste anywhere. Same
// text goes onto the clipboard and into the saved file's `text` field.
function shoppingListText(list) {
    const lines = [`Einkaufszettel${list.weekLabel ? ' ' + list.weekLabel : ''}`];
    list.groups.forEach(g => {
        lines.push('', g.title);
        g.items.forEach(it => lines.push(`- [${it.checked ? 'x' : ' '}] ${it.name}${it.price ? ' — ' + it.price : ''}`));
    });
    return lines.join('\n') + '\n';
}

function buildShoppingRow(it) {
    const li = document.createElement('li');
    li.className = 'pk-sl-item' + (it.checked ? ' checked' : '');
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'pk-sl-check' + (it.checked ? ' on' : '');
    check.textContent = it.checked ? '☑' : '☐';
    check.setAttribute('aria-label', (it.checked ? 'Haken entfernen: ' : 'Abhaken: ') + it.name);
    check.addEventListener('click', () => toggleChecked(it.normName));
    li.appendChild(check);
    const name = document.createElement('span');
    name.className = 'pk-sl-name';
    name.textContent = it.name;
    li.appendChild(name);
    if (it.price) {
        const p = document.createElement('span');
        p.className = 'pk-sl-price';
        p.textContent = it.price;
        li.appendChild(p);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pk-sl-del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Entfernen: ' + it.name);
    del.addEventListener('click', () => removeRow(it));
    li.appendChild(del);
    return li;
}

function renderShopping() {
    const section = document.getElementById('pk-shopping');
    const body = document.getElementById('pk-shopping-body');
    if (!section || !body) return;

    const list = buildShoppingList();
    const hasPlan = !!(mealplanView && mealplanView.days.length);
    const show = list.total > 0 || hasPlan;   // keep visible with a plan so you can add/re-add

    const saveBtn = document.getElementById('pk-shopping-save');
    if (saveBtn) saveBtn.hidden = !localApi;          // disk save only on the dev server
    const copyBtn = document.getElementById('pk-shopping-copy');
    if (copyBtn) copyBtn.disabled = list.total === 0;
    const addForm = document.getElementById('pk-shopping-add');
    if (addForm) addForm.style.display = show ? '' : 'none';

    if (!show) { section.style.display = 'none'; return; }
    section.style.display = '';

    body.innerHTML = '';
    list.groups.forEach(g => {
        const wrap = document.createElement('div');
        wrap.className = 'pk-sl-group ' + g.key;
        const h3 = document.createElement('h3');
        h3.textContent = g.title;
        wrap.appendChild(h3);
        const ul = document.createElement('ul');
        ul.className = 'pk-sl-list';
        g.items.forEach(it => ul.appendChild(buildShoppingRow(it)));
        wrap.appendChild(ul);
        body.appendChild(wrap);
    });
    if (list.total === 0) {
        const empty = document.createElement('p');
        empty.className = 'pk-sl-empty';
        empty.textContent = 'Zettel leer — füge unten etwas hinzu oder 🧺 ein Angebot.';
        body.appendChild(empty);
    }

    const meta = document.getElementById('pk-shopping-meta');
    if (meta) {
        meta.className = 'pk-sl-meta';
        meta.textContent = `${list.total} Position${list.total === 1 ? '' : 'en'}${list.date ? ' · ' + formatDate(list.date) : ''}`;
    }
}

function setShoppingMeta(text, cls) {
    const meta = document.getElementById('pk-shopping-meta');
    if (!meta) return;
    meta.className = 'pk-sl-meta' + (cls ? ' ' + cls : '');
    meta.textContent = text;
}

async function copyShoppingList() {
    const text = shoppingListText(buildShoppingList());
    try {
        await navigator.clipboard.writeText(text);
        setShoppingMeta('✓ In die Zwischenablage kopiert.', 'ok');
        return;
    } catch (e) {
        // Clipboard API unavailable (insecure context / denied) — fall back.
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        setShoppingMeta(ok ? '✓ In die Zwischenablage kopiert.' : 'Kopieren nicht möglich — Liste manuell markieren.', ok ? 'ok' : 'warn');
    } catch (e) {
        setShoppingMeta('Kopieren nicht möglich — Liste manuell markieren.', 'warn');
    }
}

// Local-only: persist the list to data/shopping/<date>.json via serve.py. The
// button only shows when the dev API is reachable (localApi). Groups are
// flattened to offers/pantry for the archive; the full checklist is in `text`.
async function saveShoppingList() {
    const list = buildShoppingList();
    if (!list.date) { setShoppingMeta('Keine Woche gewählt — nichts zu speichern.', 'warn'); return; }
    const offers = [], pantry = [];
    list.groups.forEach(g => g.items.forEach(it => {
        const entry = { name: it.name };
        if (it.price) entry.price = it.price;
        if (it.checked) entry.checked = true;
        (g.key === 'offer' ? offers : pantry).push(entry);
    }));
    const btn = document.getElementById('pk-shopping-save');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ …'; }
    try {
        const payload = JSON.stringify({
            weekLabel: list.weekLabel,
            date: list.date,
            savedAt: new Date().toISOString(),
            offers,
            pantry,
            text: shoppingListText(list),
        }, null, 2) + '\n';
        const res = await fetch('/api/shopping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        });
        if (!res.ok) throw new Error(`Fehler ${res.status}`);
        const j = await res.json().catch(() => ({}));
        setShoppingMeta(`✓ Abgelegt in ${j.path || 'data/shopping/'} (${list.total} Position${list.total === 1 ? '' : 'en'}).`, 'ok');
    } catch (err) {
        setShoppingMeta('Ablegen fehlgeschlagen: ' + (err && err.message ? err.message : err), 'warn');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = orig || '💾 Ablegen'; }
    }
}

// Hide a content cluster's heading when every section inside it is empty (the
// sections hide themselves via display:none). The controls cluster is always
// shown, so it's deliberately not listed here.
function updateClusters() {
    ['cluster-foryou', 'cluster-themen'].forEach(id => {
        const c = document.getElementById(id);
        if (!c) return;
        const secs = c.querySelectorAll('.pk-section');
        const anyVisible = Array.from(secs).some(s => s.style.display !== 'none');
        c.style.display = anyVisible ? '' : 'none';
    });
}

function renderAll() {
    renderHero();

    // Personalised top picks (LLM-ranked + client fallback) followed by 1-2
    // out-of-interest price discoveries.
    const fy = buildForYou();
    const discoveries = pickDiscoveries(fy.inForYou, 2);
    const forYouGrid = document.getElementById('pk-foryou-grid');
    if (forYouGrid) {
        forYouGrid.innerHTML = '';
        fy.list.forEach(o => forYouGrid.appendChild(buildCard(o)));
        discoveries.forEach(o => forYouGrid.appendChild(buildCard(o, { tag: '✨ Entdeckung' })));
    }
    const forYouSection = document.getElementById('pk-foryou');
    if (forYouSection) forYouSection.style.display = (fy.list.length + discoveries.length) ? '' : 'none';

    renderMealplan();

    fillSection('pk-vegan-grid', 'pk-vegan-intro',
        offersWhere(o => /vegan|vegetar/i.test(o.title || '')), 'vegan', { limit: 12 });
    fillSection('pk-obst-grid', 'pk-obst-intro',
        offersWhere(o => catName(o) === 'Obst & Gemüse'), 'obstgemuese', { limit: 12 });
    fillSection('pk-bier-grid', 'pk-bier-intro',
        offersWhere(o => /spezi/i.test(o.title || '') || (catName(o) === 'Getränke' && /\bbier\b|pils/i.test(o.title || ''))),
        'bierspezi', { limit: 12 });
    fillSection('pk-knueller-grid', 'pk-knueller-intro',
        offersWhere(isKnuller), 'knueller', { limit: 12 });

    updateClusters();
    updateHiddenCount();
    renderBrowse();
    paintExportStatus();   // a vote/interest change may now outdate the export
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();   // script sits at end of body; DOM is already parsed
    }
}
