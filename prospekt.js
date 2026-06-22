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
let prefs = null;           // { interests:{key:level}, votes:{title:±1}, ... }

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
];

// The reader told us up front what they love — seed those at "Favorit".
const DEFAULT_INTERESTS = { vegan: 2, obstgemuese: 2, bier: 2, spezi: 2, bio: 1 };

// Interest levels and how each one weighs into an offer's score.
const LEVELS = {
    '-1': { label: 'aus',     weight: -4, cls: 'lvl-off' },
    '0':  { label: 'neutral', weight: 0,  cls: 'lvl-neutral' },
    '1':  { label: 'mag ich', weight: 2,  cls: 'lvl-like' },
    '2':  { label: 'Favorit', weight: 4,  cls: 'lvl-fav' },
};
const LEVEL_CYCLE = [0, 1, 2, -1];   // chip click order
const VOTE_WEIGHT = 6;               // a thumb outweighs topic interest

// ── preferences (localStorage) ──
function defaultPrefs() {
    return { version: 1, interests: { ...DEFAULT_INTERESTS }, votes: {} };
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

// An offer's relevance = sum of matching interest weights + the explicit vote.
function scoreOffer(o) {
    let s = 0;
    for (const t of TOPICS) {
        if (t.test(o)) s += LEVELS[String(interestLevel(t.key))].weight;
    }
    s += voteFor(o) * VOTE_WEIGHT;
    return s;
}

// ── data loading ──
async function init() {
    loadPrefs();
    buildSteering();

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
        const opt = document.createElement('option');
        opt.value = file;
        const m = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
        opt.textContent = m ? `${m[2]} — ${m[5]}.${m[4]}.${m[1]}` : file;
        weekSelect.appendChild(opt);
    });
    weekSelect.addEventListener('change', () => {
        loadWeek(weekSelect.value);
    });

    await loadProspekt();
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
    renderAll();
}

// Optional AI editorial. Additive: absence never breaks the page.
async function loadProspekt() {
    try {
        const res = await fetch('data/prospekt.json');
        if (!res.ok) throw new Error(`status ${res.status}`);
        prospektData = await res.json();
    } catch (err) {
        prospektData = null;
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
    const hiddenToggle = document.getElementById('show-hidden');
    if (hiddenToggle) hiddenToggle.addEventListener('change', renderAll);
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
    savePrefs();
    paintChips();
    renderAll();
}

function setVote(o, value) {
    const id = o && o.id;
    if (id == null) return;
    const cur = voteFor(o);
    if (cur === value) {
        delete prefs.votes[id];        // second click on the same thumb clears it
    } else {
        prefs.votes[id] = { v: value, t: o.title || '' };
    }
    savePrefs();
    renderAll();
}

function exportPrefs() {
    const blob = new Blob([JSON.stringify(prefs, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preferences.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const hint = document.getElementById('steer-hint');
    if (hint) hint.textContent = 'preferences.json gespeichert — leg sie in data/ ab und führ am Montag generate_prospekt.py aus.';
}

function resetPrefs() {
    prefs = defaultPrefs();
    savePrefs();
    paintChips();
    renderAll();
    const hint = document.getElementById('steer-hint');
    if (hint) hint.textContent = 'Vorlieben zurückgesetzt.';
}

// ── rendering ──
function pickReason(title) {
    if (!prospektData || !Array.isArray(prospektData.picks)) return '';
    const hit = prospektData.picks.find(p => p && p.title === title);
    return hit && typeof hit.reason === 'string' ? hit.reason : '';
}

function buildCard(o) {
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
    card.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'pk-body';

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
    actions.appendChild(up);
    actions.appendChild(down);
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
        lead.textContent = txt || 'Handverlesene Angebote der Woche — vegan, frisch, mit kühlem Bier und Spezi. Sag uns mit 👍 / 🚫 und den Vorlieben oben, was dich interessiert.';
    }
}

// Filter helper for the topic sections; a throwing test (bad data) drops the
// offer rather than breaking the whole render. Sections may overlap — a product
// can appear both in "Für dich" and in its topic section, which is intended.
function offersWhere(test) {
    return currentOffers.filter(o => { try { return test(o); } catch (e) { return false; } });
}

function renderAll() {
    renderHero();

    // Personalised top picks: highest-scoring offers across the whole week,
    // but only when the reader has actually expressed a preference (score > 0).
    const forYou = currentOffers
        .map(o => ({ o, s: scoreOffer(o) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map(x => x.o);
    fillSection('pk-foryou-grid', null, forYou, null, {});
    const forYouSection = document.getElementById('pk-foryou');
    if (forYouSection) forYouSection.style.display = forYou.length ? '' : 'none';

    fillSection('pk-vegan-grid', 'pk-vegan-intro',
        offersWhere(o => /vegan|vegetar/i.test(o.title || '')), 'vegan', { limit: 12 });
    fillSection('pk-obst-grid', 'pk-obst-intro',
        offersWhere(o => catName(o) === 'Obst & Gemüse'), 'obstgemuese', { limit: 12 });
    fillSection('pk-bier-grid', 'pk-bier-intro',
        offersWhere(o => /spezi/i.test(o.title || '') || (catName(o) === 'Getränke' && /\bbier\b|pils/i.test(o.title || ''))),
        'bierspezi', { limit: 12 });
    fillSection('pk-knueller-grid', 'pk-knueller-intro',
        offersWhere(isKnuller), 'knueller', { limit: 12 });
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();   // script sits at end of body; DOM is already parsed
    }
}
