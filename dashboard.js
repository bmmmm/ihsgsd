// EDEKA Dashboard — all frontend logic (extracted verbatim from dashboard.html).
// Static, no build step: loaded via <script src="dashboard.js"> after the ECharts CDN.
// House style mirrors index.html/table.html: CSS stays inline, JS lives here.

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

const HIDDEN_CATEGORIES_DEFAULT = ['Fleisch & Wurst', 'Drogerie', 'Tiernahrung', 'Fisch & Meeresfrüchte'];

let allTrendData = [];
let allTrendCategories = [];
let activeCategories = new Set();
let charts = {};
let currentOffers = [];
let resizeHandler = null;
let insights = null;

// HTML-escape a string before interpolating it into innerHTML.
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Only allow http(s) image URLs; reject javascript:, data:, etc.
function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    return /^https?:\/\//i.test(url.trim()) ? url : '';
}

// Extract the "YYYY-MM-DD" date embedded in a data file path for sorting.
function fileDate(file) {
    const m = file.match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
}

// Local archived thumbnail path for an offer of the currently-selected
// week, e.g. "data/2026/KW23/img/123.jpg". Returns "" if undeterminable.
function localImageUrl(o) {
    const sel = document.getElementById('week-select');
    const file = sel ? sel.value : '';
    const dir = file.replace(/\/[^/]+$/, '');
    if (!dir || o == null || o.id == null) return '';
    return `data/${dir}/img/${encodeURIComponent(o.id)}.jpg`;
}

// A single data-entry outlier (a €47,150 Camembert in KW40/2025) poisons every
// average, extreme and axis range. The producer drops faces above this ceiling
// (build_indexes.py face_price); the dashboard must too.
const FACE_MAX = 500;

// Comparable face price in [0, FACE_MAX], or null if missing/implausible.
// Callers must treat null as "no price" (the real 0.00 item still returns 0).
function offerPrice(o) {
    const raw = o && o.price ? o.price.rawValue : undefined;
    const v = Number.isFinite(raw) ? raw : parseFloat(o && o.price ? o.price.value : NaN);
    return (Number.isFinite(v) && v >= 0 && v <= FACE_MAX) ? v : null;
}

// Build the <img> for an offer (local archive first, live URL as onerror
// fallback), or null if no usable source. Shared by the KPI card and list rows.
function buildOfferImage(o) {
    const liveUrl = (o.images && safeImageUrl(o.images.app || o.images.original || '')) || '';
    const localUrl = localImageUrl(o);
    const src = localUrl || liveUrl;
    if (!src) return null;
    const img = document.createElement('img');
    img.src = src;
    img.alt = o.title || '';
    if (localUrl && liveUrl) img.onerror = function () { this.onerror = null; this.src = liveUrl; };
    return img;
}

// Shared ECharts config for the line charts: a date-range slider and the grid.
// Factored out so a theme tweak touches one place; emits the same option object.
function sliderZoom() {
    return [{
        type: 'slider', start: 0, end: 100, bottom: 8, height: 22,
        borderColor: '#333', backgroundColor: '#1a1a1a',
        fillerColor: 'rgba(76, 175, 80, 0.15)',
        handleStyle: { color: '#4caf50' }, textStyle: { color: '#888' },
    }];
}

function chartGrid(bottom) {
    return { left: 10, right: 20, bottom, top: 30, containLabel: true };
}

// Show a visible error in the info bar when loading fails.
function showLoadError(err) {
    console.error('Dashboard load error:', err);
    const bar = document.getElementById('info-bar');
    if (bar) bar.textContent = 'Fehler beim Laden der Daten. Bitte Seite neu laden.';
}

async function init() {
    const weekSelect = document.getElementById('week-select');

    const files = await fetchJSON('data/folder-structure.json');
    // Sort by parsed YYYY-MM-DD descending (newest first). A blind
    // reverse() breaks at the year boundary.
    files.sort((a, b) => fileDate(b).localeCompare(fileDate(a)));

    files.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file;
        const m = file.match(/(\d{4})\/(KW\d+)\/(\d{4})-(\d{2})-(\d{2})\.json/);
        opt.textContent = m ? `${m[2]} — ${m[5]}.${m[4]}.${m[1]}` : file;
        weekSelect.appendChild(opt);
    });

    weekSelect.addEventListener('change', () => {
        loadWeek(weekSelect.value).catch(showLoadError);
    });

    await loadAllTrendData();
    await loadPriceHistory();
    await loadInsights();
    buildFiltersBar();

    if (files.length > 0) {
        await loadWeek(files[0]);
    }

    renderTrend();
    // Global cross-week KPI panels — independent of week and category, so they
    // only need to render once after the trend data is loaded.
    renderKnullerPuls();
    renderTransparenz();
    renderArchitektur();
    setupNetworkZoomGuard();

    // Single resize handler for all charts (trend lives in charts.trend).
    resizeHandler = () => {
        Object.values(charts).forEach(c => c && c.resize());
    };
    window.addEventListener('resize', resizeHandler);
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json();
}

// Optional weekly KI-Insights, generated locally via `claude -p`
// (scripts/generate_insights.py). Entirely additive: if data/insights.json is
// absent or malformed the panel stays hidden and nothing else is affected.
async function loadInsights() {
    try {
        const res = await fetch('data/insights.json');
        if (!res.ok) throw new Error(`status ${res.status}`);
        insights = await res.json();
    } catch (err) {
        insights = null;
    }
    renderInsights();
}

function renderInsights() {
    const panel = document.getElementById('insights-panel');
    if (!panel) return;
    if (!insights || typeof insights.summary !== 'string' || !insights.summary) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';

    const sub = document.getElementById('insights-sub');
    if (sub) {
        sub.textContent = insights.weekLabel
            ? `KI-Zusammenfassung der Woche ${insights.weekLabel} — lokal via claude -p erzeugt.`
            : 'KI-Zusammenfassung — lokal via claude -p erzeugt.';
    }
    const summaryEl = document.getElementById('insights-summary');
    if (summaryEl) summaryEl.textContent = insights.summary;

    fillInsightsList(document.getElementById('insights-pricier'),
        Array.isArray(insights.pricier) ? insights.pricier : [], 'pricier');
    fillInsightsList(document.getElementById('insights-deals'),
        Array.isArray(insights.deals) ? insights.deals : [], 'deals');
}

function fillInsightsList(ul, items, kind) {
    if (!ul) return;
    ul.innerHTML = '';
    const isPricier = kind === 'pricier';
    if (!items.length) {
        setEmpty(ul, isPricier ? 'Keine teureren Artikel.' : 'Keine besonderen Deals.');
        return;
    }
    const frag = document.createDocumentFragment();
    items.slice(0, 10).forEach((d, i) => {
        let badge = '';
        if (isPricier && typeof d.pct_above_min === 'number') {
            badge = `+${Math.round(d.pct_above_min)}% über Tief`;
        } else if (!isPricier && typeof d.hist_max_gp === 'number'
                   && typeof d.current_gp === 'number' && d.current_gp > 0) {
            badge = `−${Math.round((1 - d.current_gp / d.hist_max_gp) * 100)}% vs. Hoch`;
        }
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: d.title || '—',
            cat: d.cat || '—',
            sub: d.note || (d.cat || ''),
            priceText: (typeof d.current_gp === 'number' && d.unit) ? formatGp(d.current_gp, d.unit) : '',
            priceColor: isPricier ? '#ef5350' : '#66bb6a',
            badgeText: badge,
            badgeClass: isPricier ? 'bad' : 'good',
        }));
    });
    ul.appendChild(frag);
}

async function loadWeek(filePath) {
    try {
        const data = await fetchJSON(`data/${filePath}`);
        const { offers, totalCount, validFrom, validTill } = data;
        currentOffers = offers;

        document.getElementById('info-bar').textContent =
            `${totalCount} Angebote vom ${formatDate(validFrom)} bis ${formatDate(validTill)}`;

        renderFilteredWeekCharts();
    } catch (err) {
        // Don't leave the previous week's products on screen under the newly
        // selected week's label — clear and re-render to a clean empty state.
        currentOffers = [];
        renderFilteredWeekCharts();
        showLoadError(err);
    }
}

// Lazily create an ECharts instance for `name` bound to `domId`, or
// return the existing one. Charts are initialized once; subsequent
// renders only call setOption with new data (no dispose/re-init).
function getChart(name, domId) {
    if (!charts[name]) {
        charts[name] = echarts.init(document.getElementById(domId), 'dark');
    }
    return charts[name];
}

function renderFilteredWeekCharts() {
    networkZoomLevel = 1;
    const filtered = currentOffers.filter(o => activeCategories.has(o.category.name));
    renderStats(filtered);
    renderNetwork(filtered);
    renderTreemap(filtered);
    renderPriceChart(filtered);
    if (typeof renderFeatures === 'function') renderFeatures(); // FEATURE-HOOK
}

// Coalesce rapid category toggles into a single re-render pass.
let filterRenderQueued = false;
function scheduleFilteredRender() {
    if (filterRenderQueued) return;
    filterRenderQueued = true;
    requestAnimationFrame(() => {
        filterRenderQueued = false;
        renderFilteredWeekCharts();
        renderTrend();
    });
}

function formatDate(d) {
    const p = d.split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
}

// ── KPI Stats ────────────────────────────────────────────
// Builds a simple "value + label" KPI card.
// Currency formatting. Face prices (shelf price of a pack) use the suffix
// form "12.34 €"; Grundpreise (€/unit) use the prefix form "€12.34/kg".
// The two are intentionally distinct: a pack price and a cross-week
// comparable per-unit price should not look the same.
function formatEuro(n) {
    return `${Number(n).toFixed(2)} €`;
}
function formatGp(n, unit) {
    return `€${Number(n).toFixed(2)}/${unit}`;
}

function buildStatCard(value, label) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    card.append(v, l);
    return card;
}

function renderStats(offers) {
    const row = document.getElementById('stats-row');
    row.innerHTML = '';

    row.appendChild(buildStatCard(offers.length, 'Produkte'));

    const knullerCard = buildStatCard(String(offers.filter(isKnuller).length), 'Superknüller');
    knullerCard.querySelector('.stat-value').style.color = '#ff3b6b';
    row.appendChild(knullerCard);

    // GP-honest deal metrics replace the old face-price "Ø Preis" and the
    // off-goal "Teuerster Artikel": how many of this week's offered articles
    // sit at their own all-time Grundpreis low, plus the single best deal.
    const ws = document.getElementById('week-select');
    const date = (ws && fileDate(ws.value)) || (priceHistory && priceHistory.latestDate);
    const cands = date ? radarCandidates(date) : [];

    if (cands.length) {
        const atLow = cands.filter(c => c.over <= 0.001).length;
        const lowCard = buildStatCard(String(atLow), 'Allzeit-Tief-Deals');
        lowCard.querySelector('.stat-value').style.color = '#66bb6a';
        row.appendChild(lowCard);

        const best = cands.reduce((a, b) => (b.over < a.over ? b : a));
        row.appendChild(buildBestDealCard(best, offers));
    } else {
        // Fallback when no price history is loaded: the week's average shelf
        // price (face price — only meaningful within a single week).
        const prices = offers.map(offerPrice).filter(p => p !== null);
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
        row.appendChild(buildStatCard(formatEuro(avg), 'Ø Preis'));
    }
}

// Wide KPI card for the week's best Grundpreis deal. Built via DOM API so
// untrusted titles/URLs can never break out of an attribute. Reuses the
// current week's raw offer (matched by title) for a thumbnail, if present.
function buildBestDealCard(best, offers) {
    const p = best.p;
    const card = document.createElement('div');
    card.className = 'stat-card stat-card-wide';

    const match = offers.find(x => x && x.title === p.title);
    const img = match ? buildOfferImage(match) : null;
    if (img) card.appendChild(img);

    const details = document.createElement('div');
    details.className = 'stat-details';

    const value = document.createElement('div');
    value.className = 'stat-value';
    value.style.color = '#66bb6a';
    value.textContent = formatGp(best.cur, p.unit);

    const product = document.createElement('div');
    product.className = 'stat-product';
    product.title = p.title;
    product.textContent = p.title;

    const label = document.createElement('div');
    label.className = 'stat-label';
    const pct = Math.round(best.over * 100);
    label.textContent = best.over <= 0.001
        ? 'Bester Deal · Allzeit-Tief'
        : `Bester Deal · +${pct}% über Tief`;

    details.append(value, product, label);
    card.appendChild(details);
    return card;
}

// ── Load ALL trend data ──────────────────────────────────
// Reads the precomputed data/trend-index.json (one small file) instead
// of fetching and parsing every weekly snapshot (~17 MB).
async function loadAllTrendData() {
    const trendContainer = document.getElementById('chart-trend');
    trendContainer.innerHTML = '<div class="loading">Lade historische Daten...</div>';

    const index = await fetchJSON('data/trend-index.json');
    // Entries: { file, week:"YYYY-KW", date:"YYYY-MM-DD", total, counts }.
    allTrendData = [...index].sort((a, b) => a.date.localeCompare(b.date));

    const catSet = new Set();
    allTrendData.forEach(w => {
        Object.keys(w.counts || {}).forEach(c => catSet.add(c));
    });
    allTrendCategories = [...catSet].sort();
    activeCategories = new Set(allTrendCategories.filter(c => !HIDDEN_CATEGORIES_DEFAULT.includes(c)));
}

// ── Filters bar ──────────────────────────────────────────
function buildFiltersBar() {
    const activeBar = document.getElementById('filters-bar');
    const hiddenBar = document.getElementById('hidden-filters-bar');
    activeBar.innerHTML = '';
    hiddenBar.innerHTML = '';

    const activeLabel = document.createElement('span');
    activeLabel.className = 'label';
    activeLabel.textContent = 'Kategorien:';
    activeBar.appendChild(activeLabel);

    const hiddenLabel = document.createElement('span');
    hiddenLabel.className = 'label';
    hiddenLabel.textContent = 'Ausgeblendet:';
    hiddenBar.appendChild(hiddenLabel);

    allTrendCategories.forEach(cat => {
        const btn = document.createElement('button');
        const color = CATEGORY_COLORS[cat] || '#888';
        const isActive = activeCategories.has(cat);
        btn.className = 'cat-btn' + (isActive ? ' active' : '');
        btn.setAttribute('aria-pressed', String(isActive));
        btn.innerHTML = `<span class="cat-dot" style="background:${escapeHtml(color)}"></span>${escapeHtml(cat)}`;
        if (isActive) {
            btn.style.background = color;
            btn.style.borderColor = 'transparent';
        }
        btn.addEventListener('click', () => {
            if (activeCategories.has(cat)) {
                activeCategories.delete(cat);
            } else {
                activeCategories.add(cat);
            }
            distributeButtons();
            updateCategoryButtons();
            // Debounced: multi-toggle coalesces into one render pass.
            scheduleFilteredRender();
        });
        btn.dataset.cat = cat;
        (isActive ? activeBar : hiddenBar).appendChild(btn);
    });

    distributeButtons();
}

function distributeButtons() {
    const activeBar = document.getElementById('filters-bar');
    const hiddenBar = document.getElementById('hidden-filters-bar');
    const allBtns = [...document.querySelectorAll('.cat-btn')];

    allBtns.forEach(btn => {
        const cat = btn.dataset.cat;
        const isActive = activeCategories.has(cat);
        const targetBar = isActive ? activeBar : hiddenBar;
        targetBar.appendChild(btn);
    });

    hiddenBar.style.display = hiddenBar.querySelectorAll('.cat-btn').length > 0 ? '' : 'none';
}

function updateCategoryButtons() {
    document.querySelectorAll('.cat-btn').forEach(btn => {
        const cat = btn.dataset.cat;
        const isActive = activeCategories.has(cat);
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
        const color = CATEGORY_COLORS[cat] || '#888';
        btn.style.background = isActive ? color : '';
        btn.style.borderColor = isActive ? 'transparent' : '';
        btn.style.color = isActive ? '#fff' : '';
    });
}

// ── Network Graph ──────────────────────────────────────
let networkFitTimer = null;

function renderNetwork(offers) {
    // Cancel any pending auto-fit from a previous render so it can't
    // fire setOption on a re-rendered chart and clobber networkZoomLevel.
    clearTimeout(networkFitTimer);

    const chart = getChart('network', 'chart-network');

    const categories = [...new Set(offers.map(o => o.category.name))];
    // Precompute category → index once instead of indexOf per product.
    const catIndex = new Map(categories.map((cat, i) => [cat, i]));

    const categoryNodes = categories.map(cat => ({
        id: `cat_${cat}`,
        name: cat,
        symbolSize: 50,
        category: catIndex.get(cat),
        itemStyle: {
            color: CATEGORY_COLORS[cat] || '#888',
            borderColor: '#fff',
            borderWidth: 2,
        },
        label: {
            show: true,
            fontSize: 13,
            fontWeight: 'bold',
            color: '#fff',
        },
    }));

    const productNodes = offers.map(o => {
        const price = offerPrice(o) ?? 0; // outlier/no-price -> 0 in the decorative graph
        return {
            id: `p_${o.id}`,
            name: o.title,
            symbolSize: Math.max(8, Math.min(30, price * 3)),
            category: catIndex.get(o.category.name),
            value: price,
            itemStyle: {
                color: CATEGORY_COLORS[o.category.name] || '#888',
                opacity: 0.85,
            },
            label: { show: false },
        };
    });

    const links = offers.map(o => ({
        source: `p_${o.id}`,
        target: `cat_${o.category.name}`,
        lineStyle: {
            color: CATEGORY_COLORS[o.category.name] || '#888',
            opacity: 0.15,
            width: 1,
        },
    }));

    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: (params) => {
                if (params.dataType === 'node') {
                    const name = escapeHtml(params.data.name);
                    if (params.data.id.startsWith('cat_')) {
                        const count = offers.filter(o => o.category.name === params.data.name).length;
                        return `<b>${name}</b><br/>${count} Produkte`;
                    }
                    return `<b>${name}</b><br/>${formatEuro(params.data.value)}`;
                }
                return '';
            },
        },
        legend: {
            data: categories,
            textStyle: { color: '#aaa' },
            bottom: 10,
            type: 'scroll',
        },
        series: [{
            type: 'graph',
            layout: 'force',
            roam: 'move',
            draggable: true,
            categories: categories.map(cat => ({
                name: cat,
                itemStyle: { color: CATEGORY_COLORS[cat] || '#888' },
            })),
            nodes: [...categoryNodes, ...productNodes],
            links: links,
            force: {
                repulsion: 80,
                gravity: 0.25,
                edgeLength: [30, 80],
                friction: 0.6,
            },
            scaleLimit: { min: 0.1, max: 5 },
            zoom: 0.55,
            emphasis: {
                focus: 'adjacency',
                lineStyle: { opacity: 0.6, width: 2 },
            },
            animation: true,
            animationDuration: 1500,
        }],
    }, { notMerge: true });

    // Auto-fit after force layout settles. The roam guard must only be
    // attached once (the chart instance is reused across renders).
    if (!chart._roamGuardAttached) {
        chart.on('graphRoamEnd', () => clearTimeout(networkFitTimer));
        chart._roamGuardAttached = true;
    }
    networkFitTimer = setTimeout(() => {
        const model = chart.getModel().getSeries()[0];
        const nodes = model.getData();
        if (!nodes.count()) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.each((idx) => {
            const layout = nodes.getItemLayout(idx);
            if (!layout) return;
            minX = Math.min(minX, layout[0]);
            maxX = Math.max(maxX, layout[0]);
            minY = Math.min(minY, layout[1]);
            maxY = Math.max(maxY, layout[1]);
        });
        const container = chart.getDom();
        const w = container.clientWidth;
        const h = container.clientHeight;
        const graphW = maxX - minX || 1;
        const graphH = maxY - minY || 1;
        const padding = 0.8;
        const zoom = Math.min(w / graphW, h / graphH) * padding;
        const clampedZoom = Math.max(0.2, Math.min(zoom, 1.2));
        chart.setOption({ series: [{ zoom: clampedZoom, center: [(minX + maxX) / 2, (minY + maxY) / 2] }] });
        networkZoomLevel = clampedZoom;
    }, 1800);
}

// ── Treemap ────────────────────────────────────────────
function renderTreemap(offers) {
    const chart = getChart('treemap', 'chart-treemap');

    const catData = {};
    offers.forEach(o => {
        const cat = o.category.name;
        if (!catData[cat]) catData[cat] = { count: 0, totalPrice: 0, priced: 0 };
        catData[cat].count++;
        const pr = offerPrice(o);
        if (pr !== null) { catData[cat].totalPrice += pr; catData[cat].priced++; }
    });

    const treeData = Object.entries(catData).map(([name, d]) => ({
        name: `${name}\n${d.count} Produkte`,
        value: d.count,
        itemStyle: { color: CATEGORY_COLORS[name] || '#888' },
        avgPrice: (d.priced ? d.totalPrice / d.priced : 0).toFixed(2),
    }));

    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            formatter: (p) =>
                `<b>${escapeHtml(p.name.split('\n')[0])}</b><br/>` +
                `${p.value} Produkte<br/>` +
                `Ø Preis: ${p.data.avgPrice} €`,
        },
        series: [{
            type: 'treemap',
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            label: {
                show: true,
                fontSize: 14,
                fontWeight: 'bold',
                color: '#fff',
                formatter: '{b}',
            },
            itemStyle: {
                borderColor: '#0a0a0a',
                borderWidth: 3,
                gapWidth: 3,
            },
            data: treeData,
        }],
    }, { notMerge: true });
}

// ── Price Distribution ─────────────────────────────────
function renderPriceChart(offers) {
    const chart = getChart('prices', 'chart-prices');

    const catPrices = {};
    offers.forEach(o => {
        const cat = o.category.name;
        const price = offerPrice(o);
        if (price === null) return; // skip the outlier / no-price offers
        if (!catPrices[cat]) catPrices[cat] = [];
        catPrices[cat].push(price);
    });

    const categories = Object.keys(catPrices).sort();
    const avgData = categories.map(cat => {
        const prices = catPrices[cat];
        return +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
    });
    const minData = categories.map(cat => +Math.min(...catPrices[cat]).toFixed(2));
    const maxData = categories.map(cat => +Math.max(...catPrices[cat]).toFixed(2));

    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
        },
        grid: chartGrid(10),
        xAxis: {
            type: 'value',
            axisLabel: { formatter: '{value} €', color: '#888' },
            splitLine: { lineStyle: { color: '#222' } },
        },
        yAxis: {
            type: 'category',
            data: categories,
            axisLabel: {
                color: '#aaa',
                fontSize: 11,
                width: 100,
                overflow: 'truncate',
            },
        },
        series: [
            {
                name: 'Min',
                type: 'bar',
                stack: 'range',
                data: minData,
                itemStyle: { color: 'transparent' },
                emphasis: { itemStyle: { color: 'transparent' } },
            },
            {
                name: 'Preisspanne',
                type: 'bar',
                stack: 'range',
                data: categories.map((cat, i) => ({
                    value: +(maxData[i] - minData[i]).toFixed(2),
                    itemStyle: { color: CATEGORY_COLORS[cat] || '#888', opacity: 0.4 },
                })),
            },
            {
                name: 'Ø Preis',
                type: 'scatter',
                data: categories.map((cat, i) => ({
                    value: avgData[i],
                    itemStyle: { color: CATEGORY_COLORS[cat] || '#888' },
                })),
                symbolSize: 12,
                z: 10,
            },
        ],
    }, { notMerge: true });
}

// ── Trend Chart ──────────────────────────────────────────
// Extract the "KW##" display label from a "YYYY-KW##" week string.
function weekLabel(week) {
    const m = String(week).match(/KW\d+/);
    return m ? m[0] : String(week);
}

// "2024-12-09" → "09.12." for a compact secondary axis label.
function shortDate(date) {
    const p = String(date).split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}.` : String(date);
}

function renderTrend() {
    const container = document.getElementById('chart-trend');
    if (allTrendData.length === 0) {
        // Don't leave the "Lade historische Daten…" spinner stuck forever.
        container.innerHTML = '<div class="loading">Keine Trend-Daten verfügbar.</div>';
        return;
    }

    // allTrendData is sorted by date. KW labels are NOT unique
    // (collisions across/within years), so the x-axis identity is the
    // unique date; the display label is the KW + short date.
    const data = allTrendData;
    const dates = data.map(w => w.date);
    const labelByDate = new Map(
        data.map(w => [w.date, `${weekLabel(w.week)}\n${shortDate(w.date)}`])
    );
    const cats = allTrendCategories.filter(c => activeCategories.has(c));

    const chart = getChart('trend', 'chart-trend');

    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
        },
        legend: {
            data: cats,
            textStyle: { color: '#aaa', fontSize: 11 },
            bottom: 40,
            type: 'scroll',
            selected: Object.fromEntries(cats.map(c => [c, true])),
        },
        grid: chartGrid(90),
        dataZoom: sliderZoom(),
        xAxis: {
            type: 'category',
            // Unique, sortable identity; KW label is shown via formatter.
            data: dates,
            axisLabel: {
                color: '#888',
                rotate: 45,
                formatter: (date) => labelByDate.get(date) || date,
            },
        },
        yAxis: {
            type: 'value',
            name: 'Produkte',
            nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888' },
            splitLine: { lineStyle: { color: '#222' } },
        },
        series: cats.map(cat => ({
            name: cat,
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { width: 2, color: CATEGORY_COLORS[cat] || '#888' },
            itemStyle: { color: CATEGORY_COLORS[cat] || '#888' },
            areaStyle: { opacity: 0.05 },
            data: data.map(w => w.counts[cat] || 0),
        })),
    }, { notMerge: true });
}

// ── Ctrl-to-zoom for network chart ───────────────────
let networkZoomLevel = 1;

function applyNetworkZoom(factor) {
    const chart = charts.network;
    if (!chart) return;
    // Cancel a pending post-layout auto-fit so a manual zoom right after a
    // week switch isn't reset 1.8s later (auto-fit otherwise only cancels on drag).
    clearTimeout(networkFitTimer);
    networkZoomLevel *= factor;
    chart.setOption({
        series: [{
            zoom: networkZoomLevel,
        }],
    });
}

function setupNetworkZoomGuard() {
    const container = document.getElementById('chart-network');
    const hint = document.getElementById('network-zoom-hint');
    let hintTimeout = null;
    // Only hijack Ctrl +/- while the pointer is over the network panel, so the
    // shortcut doesn't steal page zoom everywhere else on the page.
    let pointerOver = false;
    container.addEventListener('mouseenter', () => { pointerOver = true; });
    container.addEventListener('mouseleave', () => { pointerOver = false; });

    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            applyNetworkZoom(e.deltaY < 0 ? 1.15 : 0.87);
        } else {
            hint.classList.add('visible');
            clearTimeout(hintTimeout);
            hintTimeout = setTimeout(() => hint.classList.remove('visible'), 1200);
        }
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (!pointerOver || !(e.ctrlKey || e.metaKey)) return;
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            applyNetworkZoom(1.2);
        } else if (e.key === '-') {
            e.preventDefault();
            applyNetworkZoom(0.83);
        }
    });
}

// ══════════════════════════════════════════════════════════
// FEATURE BLOCK (appended — self-contained, additive)
// Features:
//  1. In-dashboard product search over currentOffers
//  2. Superknüller (criteria) action-highlight: KPI + "only" toggle
//  3. Top-N cheapest & most expensive products of the week
//  4. Category share delta — this week vs. previous (from allTrendData)
// ══════════════════════════════════════════════════════════

let featureSearchQuery = '';
let featureOnlyKnuller = false;
let featuresWired = false;
let priceHistory = null; // data/price-history-index.json, enriched at load

function isKnuller(o) {
    return Array.isArray(o.criteria) && o.criteria.some(c => c && c.name === 'Superknüller');
}

// Build one <li> product row via DOM API (XSS-safe — no raw innerHTML for data).
function buildProductItem(o, opts) {
    opts = opts || {};
    const li = document.createElement('li');
    li.className = 'product-item';

    const img = buildOfferImage(o);
    if (img) li.appendChild(img);

    const body = document.createElement('div');
    body.className = 'pi-body';

    const title = document.createElement('div');
    title.className = 'pi-title';
    title.title = o.title || '';
    title.textContent = o.title || '(ohne Titel)';
    if (opts.markKnuller && isKnuller(o)) {
        const badge = document.createElement('span');
        badge.className = 'knuller-badge';
        badge.textContent = 'Knüller';
        title.appendChild(badge);
    }
    body.appendChild(title);

    const catLine = document.createElement('div');
    catLine.className = 'pi-cat';
    const catName = o.category && o.category.name ? o.category.name : '—';
    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = CATEGORY_COLORS[catName] || '#888';
    catLine.appendChild(dot);
    catLine.appendChild(document.createTextNode(catName));
    body.appendChild(catLine);

    li.appendChild(body);

    const price = document.createElement('div');
    price.className = 'pi-price';
    const pr = offerPrice(o);
    price.textContent = pr === null ? '—' : formatEuro(pr);
    li.appendChild(price);

    return li;
}

function setEmpty(ul, msg) {
    ul.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'feature-empty';
    li.textContent = msg;
    ul.appendChild(li);
}

// Offers in active categories, optionally Superknüller-only.
function featureBaseOffers() {
    return currentOffers.filter(o =>
        activeCategories.has(o.category.name) &&
        (!featureOnlyKnuller || isKnuller(o))
    );
}

function renderSearchResults(base) {
    const ul = document.getElementById('search-results');
    if (!ul) return;
    const q = featureSearchQuery.trim().toLowerCase();

    if (!q) {
        const knullerCount = base.filter(isKnuller).length;
        setEmpty(ul, base.length
            ? `${base.length} Produkte sichtbar · ${knullerCount} Superknüller — tippe zum Suchen`
            : 'Keine Produkte in den aktiven Kategorien.');
        return;
    }

    const matches = base.filter(o => {
        const t = (o.title || '').toLowerCase();
        const d = (o.description || '').toLowerCase();
        return t.includes(q) || d.includes(q);
    }).slice(0, 50);

    ul.innerHTML = '';
    if (matches.length === 0) {
        setEmpty(ul, `Keine Treffer für "${q}".`);
        return;
    }
    const frag = document.createDocumentFragment();
    matches.forEach(o => frag.appendChild(buildProductItem(o, { markKnuller: true })));
    ul.appendChild(frag);
}

function renderTopLists(base) {
    const cheapUl = document.getElementById('top-cheapest');
    const expUl = document.getElementById('top-expensive');
    if (!cheapUl || !expUl) return;

    if (base.length === 0) {
        setEmpty(cheapUl, 'Keine Produkte.');
        setEmpty(expUl, 'Keine Produkte.');
        return;
    }

    // Single sort (O(n log n)); reuse for both ends. Drop no-price/outlier
    // offers so they can't rank as #1 cheapest or most-expensive.
    const priced = base.filter(o => offerPrice(o) !== null);
    if (priced.length === 0) {
        setEmpty(cheapUl, 'Keine Produkte mit Preis.');
        setEmpty(expUl, 'Keine Produkte mit Preis.');
        return;
    }
    const sorted = priced.slice().sort((a, b) => offerPrice(a) - offerPrice(b));
    const cheapest = sorted.slice(0, 5);
    const expensive = sorted.slice(-5).reverse();

    const renderInto = (ul, list) => {
        ul.innerHTML = '';
        const frag = document.createDocumentFragment();
        list.forEach((o, i) => {
            const item = buildProductItem(o, { markKnuller: true });
            const rank = document.createElement('div');
            rank.className = 'pi-rank';
            rank.textContent = '#' + (i + 1);
            item.insertBefore(rank, item.firstChild);
            frag.appendChild(item);
        });
        ul.appendChild(frag);
    };
    renderInto(cheapUl, cheapest);
    renderInto(expUl, expensive);
}

function renderCategoryDelta() {
    const ul = document.getElementById('category-delta');
    if (!ul) return;

    const datesEl = document.getElementById('category-delta-dates');

    if (!Array.isArray(allTrendData) || allTrendData.length < 2) {
        if (datesEl) datesEl.textContent = '';
        setEmpty(ul, 'Nicht genug Wochen für einen Vergleich.');
        return;
    }

    // Determine which trend entry corresponds to the currently selected week.
    // The #week-select option value is a file path like "2024/KW05/2024-02-05.json";
    // fileDate() extracts the embedded "YYYY-MM-DD" string from it.
    const weekSelect = document.getElementById('week-select');
    const selectedDate = weekSelect ? fileDate(weekSelect.value) : '';
    let currIdx = selectedDate
        ? allTrendData.findIndex(e => e.date === selectedDate)
        : -1;

    // Fall back to the last entry if the selected date isn't in trend data.
    if (currIdx === -1) currIdx = allTrendData.length - 1;

    // No predecessor available — the selected week is the earliest in the dataset.
    if (currIdx === 0) {
        if (datesEl) datesEl.textContent = '';
        ul.innerHTML = '';
        setEmpty(ul, 'Keine Vorwoche verfügbar für den gewählten Zeitraum.');
        return;
    }

    const currEntry = allTrendData[currIdx];
    const prevEntry = allTrendData[currIdx - 1];
    const curr = currEntry.counts || {};
    const prev = prevEntry.counts || {};

    // Only categories the user keeps active; sorted by absolute change.
    const cats = allTrendCategories.filter(c => activeCategories.has(c));
    const rows = cats.map(cat => {
        const c = curr[cat] || 0;
        const p = prev[cat] || 0;
        return { cat, c, p, diff: c - p };
    }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    // Show which two weeks are being compared.
    if (datesEl) {
        datesEl.textContent = `${formatDate(prevEntry.date)} → ${formatDate(currEntry.date)}`;
    }

    ul.innerHTML = '';
    if (rows.length === 0) {
        setEmpty(ul, 'Keine aktiven Kategorien.');
        return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach(r => {
        const li = document.createElement('li');
        li.className = 'delta-item';

        const dot = document.createElement('span');
        dot.className = 'd-dot';
        dot.style.background = CATEGORY_COLORS[r.cat] || '#888';
        li.appendChild(dot);

        const name = document.createElement('span');
        name.className = 'd-name';
        name.textContent = r.cat;
        li.appendChild(name);

        const counts = document.createElement('span');
        counts.className = 'd-counts';
        counts.textContent = `${r.p} → ${r.c}`;
        li.appendChild(counts);

        const change = document.createElement('span');
        const cls = r.diff > 0 ? 'up' : (r.diff < 0 ? 'down' : 'flat');
        change.className = 'd-change ' + cls;
        const arrow = r.diff > 0 ? '▲' : (r.diff < 0 ? '▼' : '–');
        change.textContent = r.diff === 0 ? arrow : `${arrow} ${Math.abs(r.diff)}`;
        li.appendChild(change);

        frag.appendChild(li);
    });
    ul.appendChild(frag);
}

// Single entry point — additive, called from renderFilteredWeekCharts via FEATURE-HOOK.
function renderFeatures() {
    if (!featuresWired) setupFeatures();
    const base = featureBaseOffers();
    renderSearchResults(base);
    renderTopLists(base);
    renderCategoryDelta();
    renderPreisRadar();
    renderErosionTrend();
    renderKaufjetzt();
    renderPreisDuerre();
    renderLangtrend();
    renderLigatabelle();
    renderEhrlichkeit();
    renderVolatilitaet();
    renderSaison();
}

function setupFeatures() {
    if (featuresWired) return;
    featuresWired = true;

    const input = document.getElementById('feature-search-input');
    if (input) {
        input.addEventListener('input', () => {
            featureSearchQuery = input.value;
            renderSearchResults(featureBaseOffers());
        });
    }

    const toggle = document.getElementById('knuller-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            featureOnlyKnuller = !featureOnlyKnuller;
            toggle.classList.toggle('active', featureOnlyKnuller);
            toggle.setAttribute('aria-pressed', String(featureOnlyKnuller));
            renderFeatures();
        });
    }
}

// ══════════════════════════════════════════════════════════
// PRICE-HISTORY BLOCK (appended — Grundpreis over time)
// Reads data/price-history-index.json: per-product €/unit series
// keyed on a composite identity. Powers three panels:
//  1. Preis-Radar      — this week's offers vs. their all-time low
//  2. Aktionspreis-Trend — structural offer-price erosion over time
//  3. Grundpreis-Verlauf — €/unit line for one picked article
// ══════════════════════════════════════════════════════════

function medianOf(arr) {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Precompute per-product stats once, so each render is a cheap scan.
// Exact-only Grundpreise drive min/median/erosion; range/"ab €" values
// are kept for plotting but excluded from statistics.
function precomputeHistory() {
    priceHistory.products.forEach(p => {
        // One exact Grundpreis per distinct week (min, matching currentExactGp),
        // so a week with >1 exact observation isn't double-weighted in the
        // median / erosion half-split.
        const perWeek = new Map();
        for (const o of p.obs) {
            if (o.gpf !== undefined) continue;
            const cur = perWeek.get(o.d);
            perWeek.set(o.d, cur === undefined ? o.gp : Math.min(cur, o.gp));
        }
        const g = [...perWeek.keys()].sort().map(d => perWeek.get(d));
        p._ex = g;
        p._min = g.length ? Math.min(...g) : null;
        p._med = medianOf(g);
        p._exWeeks = g.length;
        p._latest = g.length ? g[g.length - 1] : null;
        // Offered-weeks elapsed since this article last hit its all-time low —
        // powers "Preis-Dürre" (how long since it was this cheap).
        let lastLowIdx = -1;
        for (let i = 0; i < g.length; i++) if (g[i] <= p._min + 1e-9) lastLowIdx = i;
        p._weeksSinceLow = lastLowIdx >= 0 ? (g.length - 1 - lastLowIdx) : null;
        // Offer-price erosion: median of the later half vs the earlier
        // half of this article's per-week exact Grundpreise. Needs >=4 weeks.
        if (g.length >= 4) {
            const half = Math.floor(g.length / 2);
            const oldM = medianOf(g.slice(0, half));
            const newM = medianOf(g.slice(g.length - half));
            p._oldM = oldM;
            p._newM = newM;
            p._erosion = (oldM && newM) ? (newM / oldM - 1) : null;
            // Coefficient of variation (stdev/mean) over the per-week prices —
            // how much this article's offer price swings week to week.
            const mean = g.reduce((a, b) => a + b, 0) / g.length;
            const variance = g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length;
            p._cv = mean > 0 ? Math.sqrt(variance) / mean : null;
            // Linear regression slope over the per-week series (index as x),
            // as a fraction of the mean per offered-week. Positive = a steady
            // upward creep the half-split erosion check can miss.
            const n = g.length;
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            for (let i = 0; i < n; i++) { sx += i; sy += g[i]; sxy += i * g[i]; sxx += i * i; }
            const denom = n * sxx - sx * sx;
            const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
            p._slope = mean > 0 ? slope / mean : null;
        } else {
            p._erosion = null;
            p._cv = null;
            p._slope = null;
        }
    });
}

async function loadPriceHistory() {
    try {
        priceHistory = await fetchJSON('data/price-history-index.json');
        precomputeHistory();
        populateGpPicker();
    } catch (err) {
        // Additive feature — a failure here must not break the dashboard.
        console.error('Price history load failed:', err);
        priceHistory = null;
    }
}

// The exact Grundpreis for product p in the given week, or null if the
// article was not offered that week with an unambiguous Grundpreis.
function currentExactGp(p, date) {
    let cur = null;
    for (const o of p.obs) {
        if (o.d === date && o.gpf === undefined) {
            cur = (cur === null) ? o.gp : Math.min(cur, o.gp);
        }
    }
    return cur;
}

// Shared row builder for the Grundpreis list panels (XSS-safe DOM API).
function buildGpRow(opts) {
    const li = document.createElement('li');
    li.className = 'product-item';

    if (opts.rank != null) {
        const r = document.createElement('div');
        r.className = 'pi-rank';
        r.textContent = '#' + opts.rank;
        li.appendChild(r);
    }

    const body = document.createElement('div');
    body.className = 'pi-body';

    const title = document.createElement('div');
    title.className = 'pi-title';
    title.title = opts.title || '';
    title.textContent = opts.title || '(ohne Titel)';
    body.appendChild(title);

    const cat = document.createElement('div');
    cat.className = 'pi-cat';
    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = CATEGORY_COLORS[opts.cat] || '#888';
    cat.appendChild(dot);
    cat.appendChild(document.createTextNode(opts.sub || opts.cat || '—'));
    body.appendChild(cat);

    li.appendChild(body);

    const right = document.createElement('div');
    right.className = 'pi-right';
    const price = document.createElement('div');
    price.className = 'pi-price';
    price.textContent = opts.priceText;
    if (opts.priceColor) price.style.color = opts.priceColor;
    right.appendChild(price);
    if (opts.badgeText) {
        const b = document.createElement('span');
        b.className = 'gp-badge ' + (opts.badgeClass || 'flat');
        b.textContent = opts.badgeText;
        right.appendChild(b);
    }
    li.appendChild(right);
    return li;
}

// Articles offered in the given week (active categories, >=3 weeks of exact
// Grundpreis history), each with its current €/unit and how far above its own
// all-time low it sits. Shared by Preis-Radar and the KPI deal cards.
function radarCandidates(date) {
    const out = [];
    if (!priceHistory) return out;
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._ex.length < 3) continue; // need history to judge a deal
        const cur = currentExactGp(p, date);
        if (cur === null) continue;
        const over = p._min > 0 ? (cur / p._min - 1) : 0;
        out.push({ p, cur, over });
    }
    return out;
}

// ── Panel 1: Preis-Radar (this week vs. own all-time low) ──
function renderPreisRadar() {
    const lowsUl = document.getElementById('deal-lows');
    const highsUl = document.getElementById('deal-highs');
    const sub = document.getElementById('preis-radar-sub');
    if (!lowsUl || !highsUl) return;
    if (!priceHistory) {
        setEmpty(lowsUl, 'Keine Preishistorie geladen.');
        setEmpty(highsUl, '—');
        return;
    }

    const ws = document.getElementById('week-select');
    const date = (ws && fileDate(ws.value)) || priceHistory.latestDate;

    const cands = radarCandidates(date);

    if (sub) {
        sub.textContent = cands.length
            ? `Woche ${formatDate(date)}: ${cands.length} angebotene Artikel mit ≥3 Wochen Preishistorie, verglichen mit ihrem eigenen Allzeit-Tief (€/Einheit).`
            : `Für die Woche ${formatDate(date)} gibt es keine angebotenen Artikel mit genug Preishistorie.`;
    }

    const lows = [...cands].sort((a, b) => a.over - b.over).slice(0, 8);
    const highs = [...cands].sort((a, b) => b.over - a.over).slice(0, 8);
    renderDealList(lowsUl, lows, 'low');
    renderDealList(highsUl, highs, 'high');
}

function renderDealList(ul, items, kind) {
    ul.innerHTML = '';
    if (!items.length) {
        setEmpty(ul, 'Keine Artikel mit genug Historie.');
        return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((d, i) => {
        const pct = Math.round(d.over * 100);
        let badgeText, badgeClass;
        if (d.over <= 0.001) {
            badgeText = 'Allzeit-Tief';
            badgeClass = 'good';
        } else {
            badgeText = `+${pct}% über Tief`;
            if (kind === 'low') badgeClass = pct <= 10 ? 'good' : 'flat';
            else badgeClass = pct >= 20 ? 'bad' : 'flat';
        }
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: d.p.title,
            cat: d.p.cat,
            sub: `Tief €${d.p._min.toFixed(2)} · Median €${(d.p._med != null ? d.p._med : 0).toFixed(2)} /${d.p.unit}`,
            priceText: formatGp(d.cur, d.p.unit),
            badgeText,
            badgeClass,
        }));
    });
    ul.appendChild(frag);
}

// ── Panel: Kaufen oder warten? (GP-percentile this week) ───
// Where today's Grundpreis sits within the article's own historical range:
// 0th percentile = as cheap as it has ever been offered.
function renderKaufjetzt() {
    const nowUl = document.getElementById('kaufjetzt-now');
    const waitUl = document.getElementById('kaufjetzt-wait');
    const sub = document.getElementById('kaufjetzt-sub');
    if (!nowUl || !waitUl) return;
    if (!priceHistory) {
        setEmpty(nowUl, 'Keine Preishistorie geladen.');
        setEmpty(waitUl, '—');
        if (sub) sub.textContent = '';
        return;
    }

    const ws = document.getElementById('week-select');
    const date = (ws && fileDate(ws.value)) || priceHistory.latestDate;

    const cands = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._exWeeks < 4) continue; // need a real distribution
        const cur = currentExactGp(p, date);
        if (cur === null) continue;
        const below = p._ex.filter(x => x < cur).length;
        const pct = Math.round(100 * below / (p._exWeeks - 1));
        cands.push({ p, cur, pct });
    }

    if (sub) {
        sub.textContent = cands.length
            ? `Woche ${formatDate(date)}: ${cands.length} angebotene Artikel mit ≥4 Wochen Historie — wo liegt der heutige Grundpreis in der eigenen Preisspanne (0 % = so günstig wie nie).`
            : `Für die Woche ${formatDate(date)} gibt es keine angebotenen Artikel mit genug Preishistorie.`;
    }

    const now = [...cands].sort((a, b) => a.pct - b.pct).slice(0, 8);
    const wait = [...cands].sort((a, b) => b.pct - a.pct).slice(0, 8);
    fillPercentileList(nowUl, now, 'now');
    fillPercentileList(waitUl, wait, 'wait');
}

function fillPercentileList(ul, items, kind) {
    ul.innerHTML = '';
    if (!items.length) { setEmpty(ul, 'Keine Artikel mit genug Historie.'); return; }
    const frag = document.createDocumentFragment();
    items.forEach((d, i) => {
        const badgeClass = kind === 'now'
            ? (d.pct <= 15 ? 'good' : 'flat')
            : (d.pct >= 80 ? 'bad' : 'flat');
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: d.p.title,
            cat: d.p.cat,
            sub: `Tief €${d.p._min.toFixed(2)} · Median €${(d.p._med != null ? d.p._med : 0).toFixed(2)} /${d.p.unit}`,
            priceText: formatGp(d.cur, d.p.unit),
            badgeText: `${d.pct}. Perzentil`,
            badgeClass,
        }));
    });
    ul.appendChild(frag);
}

// ── Panel: Preis-Dürre (weeks since own all-time low) ──────
function renderPreisDuerre() {
    const ul = document.getElementById('duerre-list');
    const sub = document.getElementById('duerre-sub');
    if (!ul) return;
    if (!priceHistory) { setEmpty(ul, 'Keine Preishistorie geladen.'); if (sub) sub.textContent = ''; return; }

    const cands = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._exWeeks < 4) continue;
        if (p._weeksSinceLow == null || p._weeksSinceLow < 1) continue;
        if (p._latest == null || p._min == null) continue;
        const over = p._min > 0 ? (p._latest / p._min - 1) : 0;
        cands.push({ p, over });
    }

    if (sub) {
        sub.textContent = cands.length
            ? `${cands.length} Artikel (≥4 Angebots-Wochen): wie lange ihr Tiefpreis schon zurückliegt und wie viel teurer der letzte Angebotspreis ist.`
            : 'Keine Artikel mit genug Historie in den aktiven Kategorien.';
    }

    const top = cands.sort((a, b) => (b.p._weeksSinceLow - a.p._weeksSinceLow) || (b.over - a.over)).slice(0, 10);
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    top.forEach((d, i) => {
        const pct = Math.round(d.over * 100);
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: d.p.title,
            cat: d.p.cat,
            sub: `Tief €${d.p._min.toFixed(2)} → zuletzt ${formatGp(d.p._latest, d.p.unit)}`,
            priceText: `vor ${d.p._weeksSinceLow} Wo.`,
            badgeText: pct > 0 ? `+${pct}% über Tief` : 'auf Tief',
            badgeClass: pct >= 20 ? 'bad' : 'flat',
        }));
    });
    ul.appendChild(frag);
}

// ── Panel: Langfrist-Trend (linear GP regression slope) ────
function renderLangtrend() {
    const ul = document.getElementById('langtrend-list');
    const sub = document.getElementById('langtrend-sub');
    if (!ul) return;
    if (!priceHistory) { setEmpty(ul, 'Keine Preishistorie geladen.'); if (sub) sub.textContent = ''; return; }

    const cands = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._slope == null || p._exWeeks < 4) continue;
        if (p._slope <= 0) continue; // only steady risers — "nicht mehr so günstig"
        cands.push(p);
    }

    if (sub) {
        sub.textContent = cands.length
            ? `${cands.length} Artikel mit stetig steigendem Grundpreis (lineare Regression über ≥4 Angebots-Wochen) — fängt schleichendes Kriechen, das der Halbjahres-Vergleich übersieht.`
            : 'Keine Artikel mit steigendem Langfrist-Trend in den aktiven Kategorien.';
    }

    const top = cands.sort((a, b) => b._slope - a._slope).slice(0, 10);
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    top.forEach((p, i) => {
        const perWk = Math.round(p._slope * 1000) / 10; // % per offered-week
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: p.title,
            cat: p.cat,
            sub: `${p._exWeeks} Wo. · €${p._min.toFixed(2)} Tief → ${formatGp(p._latest, p.unit)}`,
            priceText: `+${perWk}%/Wo.`,
            priceColor: '#ef5350',
            badgeText: `Median €${(p._med != null ? p._med : 0).toFixed(2)}`,
            badgeClass: 'flat',
        }));
    });
    ul.appendChild(frag);
}

// ── Panel 2: Aktionspreis-Trend (structural erosion) ───────
function renderErosionTrend() {
    const upUl = document.getElementById('erosion-up');
    const downUl = document.getElementById('erosion-down');
    const sub = document.getElementById('erosion-sub');
    if (!upUl || !downUl) return;
    if (!priceHistory) {
        setEmpty(upUl, 'Keine Preishistorie geladen.');
        setEmpty(downUl, '—');
        return;
    }

    const cands = priceHistory.products.filter(p =>
        activeCategories.has(p.cat) && p._erosion != null && p._ex.length >= 4);
    const up = cands.filter(p => p._erosion > 0.05)
        .sort((a, b) => b._erosion - a._erosion).slice(0, 10);
    const down = cands.filter(p => p._erosion < -0.05)
        .sort((a, b) => a._erosion - b._erosion).slice(0, 10);

    if (sub) {
        sub.textContent = `Median-Grundpreis der frühen vs. späten Angebote je Artikel (≥4 Wochen exakter Grundpreis, ${cands.length} Artikel). Unabhängig von der gewählten Woche.`;
    }

    const fill = (ul, list, rising) => {
        ul.innerHTML = '';
        if (!list.length) {
            setEmpty(ul, 'Keine Artikel über der Schwelle.');
            return;
        }
        const frag = document.createDocumentFragment();
        list.forEach((p, i) => {
            const pct = Math.round(p._erosion * 100);
            frag.appendChild(buildGpRow({
                rank: i + 1,
                title: p.title,
                cat: p.cat,
                sub: `früher €${p._oldM.toFixed(2)} → jetzt €${p._newM.toFixed(2)} /${p.unit}`,
                // Arrow glyph so direction isn't conveyed by colour alone (a11y).
                priceText: `${rising ? '▲' : '▼'} ${pct > 0 ? '+' : ''}${pct}%`,
                priceColor: rising ? '#ef5350' : '#66bb6a',
                badgeText: `${p._exWeeks} Wo.`,
                badgeClass: 'flat',
            }));
        });
        ul.appendChild(frag);
    };
    fill(upUl, up, true);
    fill(downUl, down, false);
}

// ── Panel 3: Grundpreis-Verlauf (single article) ───────────

// Normalize a string for umlaut-friendly search:
// ä→ae, ö→oe, ü→ue, Ä→ae, Ö→oe, Ü→ue, ß→ss, then lowercase.
function gpNorm(s) {
    return String(s)
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss');
}

function populateGpPicker() {
    const input = document.getElementById('gp-picker-input');
    const dropdown = document.getElementById('gp-picker-dropdown');
    const currentLabel = document.getElementById('gp-picker-current');
    if (!input || !dropdown || !priceHistory) return;

    // Only articles with >=3 exact weeks give a meaningful line.
    // products is already sorted by history depth (deepest first).
    const pickable = priceHistory.products
        .map((p, idx) => ({ p, idx }))
        .filter(x => x.p._exWeeks >= 3);

    if (!pickable.length) {
        input.placeholder = 'Keine Artikel mit genug Preishistorie.';
        input.disabled = true;
        return;
    }

    // Pre-build normalised search tokens for each entry (title + cat).
    pickable.forEach(x => {
        x._norm = gpNorm(x.p.title + ' ' + (x.p.cat || ''));
    });

    // Track currently selected product index (into priceHistory.products).
    let selectedIdx = pickable[0].idx;
    let activeItemEl = null;    // the currently keyboard-highlighted <div>

    function selectProduct(idx, titleText) {
        selectedIdx = idx;
        const p = priceHistory.products[idx];
        input.value = titleText || p.title;
        if (currentLabel) {
            currentLabel.innerHTML = 'Ausgewählt: <strong>' + escapeHtml(p.title) + '</strong>' +
                ' &mdash; ' + escapeHtml(p.cat || '—') + ', ' + p._exWeeks + '&nbsp;Wochen';
        }
        input.setAttribute('aria-expanded', 'false');
        dropdown.classList.remove('open');
        activeItemEl = null;
        renderGpTrend(p);
    }

    function buildDropdown(query) {
        dropdown.innerHTML = '';
        const q = gpNorm(query || '');
        const matched = q ? pickable.filter(x => x._norm.includes(q)) : pickable;

        if (!matched.length) {
            const empty = document.createElement('div');
            empty.className = 'gp-dd-empty';
            empty.textContent = 'Keine Übereinstimmungen für „' + (query || '') + '"';
            dropdown.appendChild(empty);
            input.setAttribute('aria-expanded', 'true');
            dropdown.classList.add('open');
            activeItemEl = null;
            return;
        }

        // Group by category, sort groups alphabetically.
        const byCat = new Map();
        matched.forEach(x => {
            const cat = x.p.cat || '—';
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(x);
        });
        const cats = [...byCat.keys()].sort();

        const frag = document.createDocumentFragment();
        cats.forEach(cat => {
            const group = document.createElement('div');
            group.className = 'gp-dd-group';
            group.setAttribute('role', 'group');

            const groupLabel = document.createElement('div');
            groupLabel.className = 'gp-dd-group-label';
            groupLabel.textContent = cat;
            group.appendChild(groupLabel);

            byCat.get(cat).forEach(x => {
                const item = document.createElement('div');
                item.className = 'gp-dd-item';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(x.idx === selectedIdx));
                item.dataset.idx = String(x.idx);

                const dot = document.createElement('span');
                dot.className = 'gp-dd-cat-dot';
                dot.style.background = CATEGORY_COLORS[cat] || '#888';
                item.appendChild(dot);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = x.p.title;
                item.appendChild(nameSpan);

                const weeksSpan = document.createElement('span');
                weeksSpan.className = 'gp-dd-weeks';
                weeksSpan.textContent = x.p._exWeeks + ' Wo.';
                item.appendChild(weeksSpan);

                item.addEventListener('mousedown', (e) => {
                    // mousedown fires before blur — prevent the blur from closing before click.
                    e.preventDefault();
                    selectProduct(x.idx, x.p.title);
                });
                group.appendChild(item);
            });

            frag.appendChild(group);
        });

        dropdown.appendChild(frag);
        activeItemEl = null;
        input.setAttribute('aria-expanded', 'true');
        dropdown.classList.add('open');
    }

    function closeDropdown() {
        dropdown.classList.remove('open');
        input.setAttribute('aria-expanded', 'false');
        activeItemEl = null;
    }

    function getAllItems() {
        return Array.from(dropdown.querySelectorAll('.gp-dd-item'));
    }

    function setActive(el) {
        if (activeItemEl) activeItemEl.classList.remove('active');
        activeItemEl = el;
        if (el) {
            el.classList.add('active');
            el.scrollIntoView({ block: 'nearest' });
        }
    }

    input.addEventListener('input', () => {
        buildDropdown(input.value);
    });

    input.addEventListener('focus', () => {
        buildDropdown(input.value);
    });

    input.addEventListener('blur', () => {
        // Small delay lets mousedown on an item fire first.
        setTimeout(() => closeDropdown(), 120);
    });

    input.addEventListener('keydown', (e) => {
        const items = getAllItems();
        if (!dropdown.classList.contains('open')) {
            if (e.key === 'ArrowDown' || e.key === 'Enter') buildDropdown(input.value);
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = items[activeItemEl ? items.indexOf(activeItemEl) + 1 : 0];
            if (next) setActive(next);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const idx = activeItemEl ? items.indexOf(activeItemEl) - 1 : items.length - 1;
            if (idx >= 0) setActive(items[idx]);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeItemEl) {
                const pidx = Number(activeItemEl.dataset.idx);
                selectProduct(pidx, priceHistory.products[pidx].title);
            }
        } else if (e.key === 'Escape') {
            closeDropdown();
            // Restore the label of the currently selected product.
            input.value = priceHistory.products[selectedIdx]
                ? priceHistory.products[selectedIdx].title : '';
        }
    });

    // Initial selection: show the product with deepest history.
    selectProduct(pickable[0].idx, pickable[0].p.title);
}

function renderGpTrend(p) {
    const sub = document.getElementById('gp-trend-sub');
    if (!priceHistory || !p) return;

    const all = [...p.obs].sort((a, b) => a.d < b.d ? -1 : (a.d > b.d ? 1 : 0));
    const dates = all.map(o => o.d);
    // Exact values form the connected line; flagged ones a grey scatter.
    const exactLine = all.map(o => o.gpf === undefined ? o.gp : null);
    const flaggedPts = all.filter(o => o.gpf !== undefined).map(o => [o.d, o.gp]);
    const color = CATEGORY_COLORS[p.cat] || '#4caf50';
    const weeks = new Set(dates).size;

    if (sub) {
        sub.textContent = `${p.title} — Grundpreis in €/${p.unit} über ${weeks} Wochen. ` +
            `Tief €${(p._min != null ? p._min : 0).toFixed(2)}, Median €${(p._med != null ? p._med : 0).toFixed(2)}. ` +
            `Graue Punkte: Range-/„ab €"-Werte (unsicher).`;
    }

    const markLineData = (p._med != null)
        ? [{ yAxis: +p._med.toFixed(2), name: 'Median' }]
        : [];

    const chart = getChart('gpTrend', 'chart-gp-trend');
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: ['Grundpreis', 'unsicher'], textStyle: { color: '#aaa', fontSize: 11 }, bottom: 40 },
        grid: chartGrid(90),
        dataZoom: sliderZoom(),
        xAxis: {
            type: 'category', data: dates,
            axisLabel: { color: '#888', rotate: 45, formatter: (d) => shortDate(d) },
        },
        yAxis: {
            type: 'value', name: `€/${p.unit}`, nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888', formatter: '{value} €' },
            splitLine: { lineStyle: { color: '#222' } },
        },
        series: [
            {
                name: 'Grundpreis', type: 'line', connectNulls: true,
                symbol: 'circle', symbolSize: 7, data: exactLine,
                lineStyle: { width: 2, color }, itemStyle: { color },
                markLine: {
                    silent: true, symbol: 'none',
                    lineStyle: { color: '#666', type: 'dashed' },
                    label: { color: '#999', formatter: 'Median' },
                    data: markLineData,
                },
            },
            {
                name: 'unsicher', type: 'scatter', data: flaggedPts,
                symbol: 'circle', symbolSize: 6, itemStyle: { color: '#555' },
            },
        ],
    }, { notMerge: true });
}

// ══════════════════════════════════════════════════════════
// EXTRA PANELS — visualize the trend-index KPIs that were shipped but never
// shown (knuller/payback/gpCoverage/avgFace/medFace) plus deeper Grundpreis
// cuts. All additive; each guards its own DOM and the loaded data.
// ══════════════════════════════════════════════════════════

// Generic date-axis line chart over allTrendData (drives the global KPI
// panels). series items: {name, color, get(week)->number, area?, markLine?}.
function renderDateLineChart(chartName, domId, series, yAxis) {
    if (!allTrendData.length) return;
    const data = allTrendData;
    const dates = data.map(w => w.date);
    const labelByDate = new Map(data.map(w => [w.date, `${weekLabel(w.week)}\n${shortDate(w.date)}`]));
    const chart = getChart(chartName, domId);
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        legend: { data: series.map(s => s.name), textStyle: { color: '#aaa', fontSize: 11 }, bottom: 40, type: 'scroll' },
        grid: chartGrid(90),
        dataZoom: sliderZoom(),
        xAxis: {
            type: 'category', data: dates,
            axisLabel: { color: '#888', rotate: 45, formatter: (d) => labelByDate.get(d) || d },
        },
        yAxis: Object.assign({
            type: 'value', nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888' }, splitLine: { lineStyle: { color: '#222' } },
        }, yAxis),
        series: series.map(s => ({
            name: s.name, type: 'line', smooth: true, symbol: 'circle', symbolSize: 6,
            lineStyle: { width: 2, color: s.color }, itemStyle: { color: s.color },
            areaStyle: s.area ? { opacity: 0.06 } : undefined,
            data: data.map(s.get), markLine: s.markLine,
        })),
    }, { notMerge: true });
}

// ── Superknüller-Puls: action-tag counts over time (global) ──
function renderKnullerPuls() {
    renderDateLineChart('knullerPuls', 'chart-knuller-puls', [
        { name: 'Superknüller', color: '#ff3b6b', get: w => w.knuller || 0, area: true },
        { name: 'PAYBACK', color: '#42a5f5', get: w => w.payback || 0 },
    ], { name: 'Aktionen' });
}

// ── Transparenz-Index: Grundpreis coverage over time (global) ──
function renderTransparenz() {
    if (!allTrendData.length) return;
    const vals = allTrendData.map(w => (w.gpCoverage || 0) * 100);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    renderDateLineChart('transparenz', 'chart-transparenz', [{
        name: 'Grundpreis-Abdeckung', color: '#66bb6a', area: true,
        get: w => +((w.gpCoverage || 0) * 100).toFixed(1),
        markLine: {
            silent: true, symbol: 'none', lineStyle: { color: '#666', type: 'dashed' },
            label: { color: '#999', formatter: `Ø ${mean.toFixed(0)}%` },
            data: [{ yAxis: +mean.toFixed(1) }],
        },
    }], { name: '%', min: 0, max: 100, axisLabel: { color: '#888', formatter: '{value}%' } });
}

// ── Preis-Architektur: avg vs median face price = skew (global) ──
function renderArchitektur() {
    renderDateLineChart('architektur', 'chart-architektur', [
        { name: 'Ø Preis', color: '#ffa726', get: w => w.avgFace },
        { name: 'Median', color: '#42a5f5', get: w => w.medFace, area: true },
    ], { name: '€', axisLabel: { color: '#888', formatter: '{value} €' } });
}

// ── Superknüller-Ehrlichkeitscheck: is the "Knüller" price low? ──
function renderEhrlichkeit() {
    const goodUl = document.getElementById('honest-good');
    const badUl = document.getElementById('honest-bad');
    const sub = document.getElementById('honest-sub');
    if (!goodUl || !badUl) return;
    if (!priceHistory) { setEmpty(goodUl, 'Keine Preishistorie geladen.'); setEmpty(badUl, '—'); return; }

    const cands = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._med == null || p._exWeeks < 3) continue;
        const kvals = p.obs.filter(o => o.k === 1 && o.gpf === undefined).map(o => o.gp);
        if (!kvals.length) continue;
        const kmin = Math.min(...kvals);
        cands.push({ p, kmin, ratio: kmin / p._med });
    }
    if (sub) {
        sub.textContent = cands.length
            ? `${cands.length} als Superknüller beworbene Artikel (≥3 Wochen Historie): Knüller-Grundpreis vs. eigener Median (€/Einheit).`
            : 'Keine Superknüller-Artikel mit genug Preishistorie in den aktiven Kategorien.';
    }
    const good = cands.filter(c => c.ratio <= 0.95).sort((a, b) => a.ratio - b.ratio).slice(0, 10);
    const bad = cands.filter(c => c.ratio >= 1.0).sort((a, b) => b.ratio - a.ratio).slice(0, 10);
    fillHonest(goodUl, good, true);
    fillHonest(badUl, bad, false);
    renderEhrlichkeitChart(cands);
}

function fillHonest(ul, items, isGood) {
    ul.innerHTML = '';
    if (!items.length) { setEmpty(ul, isGood ? 'Keine echten Knüller.' : 'Keine Mogelpackungen.'); return; }
    const frag = document.createDocumentFragment();
    items.forEach((c, i) => {
        const pct = isGood ? Math.round((1 - c.ratio) * 100) : Math.round((c.ratio - 1) * 100);
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: c.p.title,
            cat: c.p.cat,
            sub: `Median €${c.p._med.toFixed(2)}/${c.p.unit} · ${c.p._exWeeks} Wo.`,
            priceText: formatGp(c.kmin, c.p.unit),
            priceColor: isGood ? '#66bb6a' : '#ef5350',
            badgeText: isGood ? `${pct}% unter Median` : `+${pct}% über Median`,
            badgeClass: isGood ? 'good' : 'bad',
        }));
    });
    ul.appendChild(frag);
}

// Diverging bars for the honesty check: each Superknüller's Grundpreis as a
// signed % deviation from the article's OWN median (0 = honesty line). Green
// below, amber inside the 5% buffer, red at/above = Mogelpackung. Faint ticks
// mark the article's own all-time low/high so a Knüller priced near its own
// high is exposed at a glance.
function renderEhrlichkeitChart(cands) {
    const el = document.getElementById('chart-ehrlichkeit');
    if (!el) return;
    const chart = getChart('ehrlich', 'chart-ehrlichkeit');
    if (!priceHistory || !cands || !cands.length) { chart.clear(); return; }

    const GREEN = '#66bb6a', AMBER = '#ffa726', RED = '#ef5350';
    const colorFor = (dev) => dev <= -5 ? GREEN : dev >= 0 ? RED : AMBER;

    const rows = cands.map(c => {
        const lo = Math.min(...c.p._ex), hi = Math.max(...c.p._ex);
        return {
            title: c.p.title, cat: c.p.cat, unit: c.p.unit,
            med: c.p._med, kmin: c.kmin, weeks: c.p._exWeeks,
            dev: +((c.ratio - 1) * 100).toFixed(1),       // Knüller-GP vs own median
            devLo: +((lo / c.p._med - 1) * 100).toFixed(1), // own cheapest, % vs median
            devHi: +((hi / c.p._med - 1) * 100).toFixed(1), // own dearest, % vs median
        };
    });

    // Align with the lists (10 each): show the 12 most-Mogel + 12 most-honest
    // so the amber middle stays visible without overflowing the panel.
    const N = 12;
    let shown;
    if (rows.length > 2 * N) {
        const asc = [...rows].sort((a, b) => a.dev - b.dev);
        shown = [...asc.slice(0, N), ...asc.slice(-N)];
    } else {
        shown = [...rows];
    }
    // Sort so green clusters top, red bottom under the inverse y-axis.
    shown.sort((a, b) => b.dev - a.dev);
    const names = shown.map(r => r.title);

    chart.setOption({
        backgroundColor: 'transparent',
        grid: { left: 10, right: 64, top: 28, bottom: 8, containLabel: true },
        tooltip: {
            trigger: 'item',
            formatter: (p) => {
                const r = shown[p.dataIndex];
                const verdict = r.dev <= -5 ? 'Echter Knüller' : r.dev >= 0 ? 'Mogelpackung' : 'Grenzfall';
                const sign = r.dev > 0 ? '+' : '';
                const hiSign = r.devHi > 0 ? '+' : '';
                return `${escapeHtml(r.title)}<br/>`
                    + `<b style="color:${colorFor(r.dev)}">${verdict}</b>: ${sign}${r.dev}% vs. eigener Median<br/>`
                    + `Knüller ${formatGp(r.kmin, r.unit)} · Median ${formatGp(r.med, r.unit)}<br/>`
                    + `eigene Spanne ${r.devLo}%…${hiSign}${r.devHi}% · ${r.weeks} Wo.`;
            },
        },
        xAxis: {
            type: 'value', name: '% vs. eigener Median',
            nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888', formatter: '{value}%' },
            splitLine: { lineStyle: { color: '#222' } },
            axisLine: { lineStyle: { color: '#333' } },
        },
        yAxis: {
            type: 'category', inverse: true, data: names,
            axisLabel: { color: '#aaa', fontSize: 11, width: 170, overflow: 'truncate' },
            axisLine: { lineStyle: { color: '#333' } },
            axisTick: { show: false },
        },
        series: [
            {
                type: 'bar', barMaxWidth: 16,
                data: shown.map(r => ({ value: r.dev, itemStyle: { color: colorFor(r.dev) } })),
                label: {
                    show: true, color: '#ccc', fontSize: 10,
                    position: (pr) => (shown[pr.dataIndex].dev >= 0 ? 'right' : 'left'),
                    formatter: (pr) => { const d = shown[pr.dataIndex].dev; return (d > 0 ? '+' : '') + d + '%'; },
                },
                markLine: {
                    symbol: 'none', silent: true,
                    lineStyle: { color: '#888', type: 'dashed' },
                    label: { color: '#999', formatter: 'Median', position: 'insideEndTop' },
                    data: [{ xAxis: 0 }],
                },
                markArea: {
                    silent: true,
                    itemStyle: { color: 'rgba(255,167,38,0.08)' }, // Grenzfall buffer -5%..0%
                    data: [[{ xAxis: -5 }, { xAxis: 0 }]],
                },
                // inverse:true flips only the visual order; coord category
                // index i still matches the bar at data index i, so the ticks
                // annotate the correct rows.
                markPoint: {
                    silent: true, symbol: 'rect', symbolSize: [2, 13],
                    itemStyle: { color: 'rgba(255,255,255,0.30)' },
                    label: { show: false },
                    data: [
                        ...shown.map((r, i) => ({ coord: [r.devLo, i] })),
                        ...shown.map((r, i) => ({ coord: [r.devHi, i] })),
                    ],
                },
            },
        ],
    }, { notMerge: true });
}

// ── Grundpreis-Ligatabelle: cheapest €/unit this week (week-dependent) ──
function renderLigatabelle() {
    const kgUl = document.getElementById('liga-kg');
    const lUl = document.getElementById('liga-l');
    const sub = document.getElementById('liga-sub');
    if (!kgUl || !lUl) return;
    if (!priceHistory) { setEmpty(kgUl, 'Keine Preishistorie geladen.'); setEmpty(lUl, '—'); return; }
    const ws = document.getElementById('week-select');
    const date = (ws && fileDate(ws.value)) || priceHistory.latestDate;

    const kg = [], l = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        const cur = currentExactGp(p, date);
        if (cur == null) continue;
        if (p.unit === 'kg') kg.push({ p, cur });
        else if (p.unit === 'l') l.push({ p, cur });
    }
    kg.sort((a, b) => a.cur - b.cur);
    l.sort((a, b) => a.cur - b.cur);
    if (sub) {
        sub.textContent = `Günstigste exakte Grundpreise der Woche ${formatDate(date)} — je Einheit getrennt (kg und l werden nie gemischt).`;
    }
    fillLiga(kgUl, kg.slice(0, 10), 'kg');
    fillLiga(lUl, l.slice(0, 10), 'l');
}

function fillLiga(ul, items, unit) {
    ul.innerHTML = '';
    if (!items.length) { setEmpty(ul, `Keine Artikel mit €/${unit} diese Woche.`); return; }
    const frag = document.createDocumentFragment();
    items.forEach((d, i) => {
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: d.p.title,
            cat: d.p.cat,
            sub: d.p.cat || '—',
            priceText: formatGp(d.cur, unit),
            badgeText: (d.p._min != null && d.cur <= d.p._min * 1.001) ? 'Allzeit-Tief' : '',
            badgeClass: 'good',
        }));
    });
    ul.appendChild(frag);
}

// ── Preis-Volatilität: which staples swing most week to week ──
function renderVolatilitaet() {
    const hiUl = document.getElementById('vol-high');
    const loUl = document.getElementById('vol-low');
    const sub = document.getElementById('vol-sub');
    if (!hiUl || !loUl) return;
    if (!priceHistory) { setEmpty(hiUl, 'Keine Preishistorie geladen.'); setEmpty(loUl, '—'); return; }
    const cands = priceHistory.products.filter(p =>
        activeCategories.has(p.cat) && p._cv != null && p._ex.length >= 4);
    const hi = [...cands].sort((a, b) => b._cv - a._cv).slice(0, 10);
    const lo = [...cands].sort((a, b) => a._cv - b._cv).slice(0, 10);
    if (sub) {
        sub.textContent = `Variationskoeffizient (Streuung ÷ Mittel) des Grundpreises über ≥4 Wochen, ${cands.length} Artikel.`;
    }
    fillVol(hiUl, hi);
    fillVol(loUl, lo);
    renderVolWaitChart(hi);
}

function fillVol(ul, items) {
    ul.innerHTML = '';
    if (!items.length) { setEmpty(ul, 'Keine Artikel mit genug Historie.'); return; }
    const frag = document.createDocumentFragment();
    items.forEach((p, i) => {
        const lo = Math.min(...p._ex), hi = Math.max(...p._ex);
        frag.appendChild(buildGpRow({
            rank: i + 1,
            title: p.title,
            cat: p.cat,
            sub: `€${lo.toFixed(2)}–€${hi.toFixed(2)}/${p.unit} · ${p._exWeeks} Wo.`,
            priceText: `${Math.round(p._cv * 100)}%`,
            badgeText: `Median €${(p._med != null ? p._med : 0).toFixed(2)}`,
            badgeClass: 'flat',
        }));
    });
    ul.appendChild(frag);
}

// Floating range bars for the most volatile staples (left "lohnt zu warten"
// column). Each row: a faint full-swing track (own all-time low→high) for
// context, plus a solid category-colored bar = the downside room from the
// article's all-time low to its current price. A "pay now" dot sitting high
// above the floor tick = swings a lot AND expensive now = wait.
function renderVolWaitChart(hi) {
    const dom = document.getElementById('vol-wait-chart');
    if (!dom) return;
    // Fewer than 2 rows: hide the canvas, the text list below still renders.
    if (!priceHistory || !hi || hi.length < 2) {
        dom.style.display = 'none';
        if (charts.volWait) charts.volWait.clear();
        return;
    }
    dom.style.display = '';

    // ECharts paints the category axis bottom→top; reverse so rank #1 is on top.
    const rows = [...hi].reverse();
    const catColor = (p) => CATEGORY_COLORS[p.cat] || '#888';
    const trunc = (s) => (s.length > 30 ? s.slice(0, 29) + '…' : s);

    const labels = rows.map(p => trunc(p.title));
    const ext = rows.map(p => ({ lo: Math.min(...p._ex), hi: Math.max(...p._ex) }));

    // Swing track (faint): spacer 0→lo, then lo→hi. Downside-room (solid):
    // spacer 0→_min, then _min→_latest. All values positive, so stacking is safe.
    const trackSpacer = ext.map(e => +e.lo.toFixed(4));
    const trackSpan = ext.map(e => +(e.hi - e.lo).toFixed(4));
    const roomSpacer = rows.map(p => +p._min.toFixed(4));
    const roomSpan = rows.map(p => +Math.max(0, p._latest - p._min).toFixed(4));
    const floorPts = rows.map((p, i) => [p._min, i]);
    const latestPts = rows.map((p, i) => [p._latest, i]);

    // ~36px per row keeps a 10-row chart readable; size before getChart so init measures right.
    dom.style.height = (rows.length * 36 + 56) + 'px';
    const chart = getChart('volWait', 'vol-wait-chart');

    chart.setOption({
        backgroundColor: 'transparent',
        grid: chartGrid(30),
        tooltip: {
            trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: (ps) => {
                // Every series shares the row's category index; read it off the
                // visible bar (the silent spacer series may be ordered first).
                const hit = ps.find(s => s.seriesName === 'Spielraum nach unten') || ps[0];
                const i = hit.dataIndex, p = rows[i], e = ext[i];
                const pctRoom = p._latest > 0 ? Math.round((p._latest - p._min) / p._latest * 100) : 0;
                const overFloor = p._min > 0 ? Math.round((p._latest / p._min - 1) * 100) : 0;
                const since = p._weeksSinceLow != null ? ` · ${p._weeksSinceLow} Wo. seit Tief` : '';
                return `${escapeHtml(p.title)}<br/>`
                    + `<span style="color:${catColor(p)}">●</span> ${escapeHtml(p.cat)}<br/>`
                    + `Jetzt: €${p._latest.toFixed(2)}/${escapeHtml(p.unit)} (+${overFloor}% über Tief)<br/>`
                    + `Spanne: €${e.lo.toFixed(2)}–€${e.hi.toFixed(2)} · Median €${(p._med != null ? p._med : 0).toFixed(2)}<br/>`
                    + `Spielraum nach unten: €${(p._latest - p._min).toFixed(2)} (${pctRoom}%)<br/>`
                    + `Schwankung (CV): ${Math.round(p._cv * 100)}% · ${p._exWeeks} Wo.${since}`;
            },
        },
        xAxis: {
            type: 'value', name: '€ / Einheit', nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888', formatter: '{value} €' },
            splitLine: { lineStyle: { color: '#222' } },
        },
        yAxis: {
            type: 'category', data: labels,
            axisLabel: { color: '#aaa', fontSize: 11 },
            axisTick: { show: false }, axisLine: { lineStyle: { color: '#333' } },
        },
        series: [
            { name: 'track-spacer', type: 'bar', stack: 'track', silent: true,
              itemStyle: { color: 'transparent' }, emphasis: { disabled: true },
              barWidth: '70%', barGap: '-100%', data: trackSpacer },
            { name: 'Spanne (Tief–Hoch)', type: 'bar', stack: 'track', silent: true,
              itemStyle: { color: '#2b2b2b', borderRadius: 3 }, emphasis: { disabled: true },
              barWidth: '70%', barGap: '-100%', data: trackSpan },
            { name: 'room-spacer', type: 'bar', stack: 'room', silent: true,
              itemStyle: { color: 'transparent' }, emphasis: { disabled: true },
              barWidth: '70%', barGap: '-100%', data: roomSpacer },
            { name: 'Spielraum nach unten', type: 'bar', stack: 'room',
              barWidth: '70%', barGap: '-100%',
              itemStyle: { color: (pr) => catColor(rows[pr.dataIndex]), borderRadius: [0, 3, 3, 0], opacity: 0.9 },
              label: { show: true, position: 'right', color: '#ddd', fontSize: 11,
                       formatter: (pr) => `€${rows[pr.dataIndex]._latest.toFixed(2)}` },
              data: roomSpan,
              markPoint: {
                  silent: true,
                  data: [
                      ...floorPts.map(c => ({ coord: c, symbol: 'rect', symbolSize: [2, 16], itemStyle: { color: '#666' } })),
                      ...latestPts.map(c => ({ coord: c, symbol: 'circle', symbolSize: 9, itemStyle: { color: '#fff', borderColor: '#111', borderWidth: 1 } })),
                  ],
              },
            },
        ],
    }, { notMerge: true });
    chart.resize();
}

// ── Saisonale Kategorie-Muster: month × category heatmap ───
const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function renderSaison() {
    const sub = document.getElementById('saison-sub');
    if (!document.getElementById('chart-saison') || !allTrendData.length) return;
    const cats = allTrendCategories.filter(c => activeCategories.has(c));
    if (!cats.length) return;

    // Per (month-of-year, category): mean weekly offer count across all years.
    const sums = {}; // "mm|cat" -> {sum, n}
    const monthsSeen = new Set();
    allTrendData.forEach(w => {
        const mm = Number((w.date || '').slice(5, 7)) - 1; // 0..11
        if (mm < 0 || mm > 11) return;
        monthsSeen.add(mm);
        cats.forEach(cat => {
            const key = `${mm}|${cat}`;
            if (!sums[key]) sums[key] = { sum: 0, n: 0 };
            sums[key].sum += (w.counts && w.counts[cat]) || 0;
            sums[key].n++;
        });
    });
    const months = [...monthsSeen].sort((a, b) => a - b);
    const cells = [];
    let maxV = 0;
    months.forEach((mm, xi) => {
        cats.forEach((cat, yi) => {
            const s = sums[`${mm}|${cat}`];
            const v = s ? +(s.sum / s.n).toFixed(1) : 0;
            if (v > maxV) maxV = v;
            cells.push([xi, yi, v]);
        });
    });
    if (sub) {
        sub.textContent = `Ø Angebote je Monat und Kategorie über ${allTrendData.length} Wochen (~${Math.round(allTrendData.length / 4.3)} Monate Datenbasis — saisonale Aussagen mit Vorsicht).`;
    }
    const chart = getChart('saison', 'chart-saison');
    chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
            position: 'top',
            formatter: (pp) => `${MONTH_NAMES[months[pp.value[0]]]} · ${escapeHtml(cats[pp.value[1]])}<br/>Ø ${pp.value[2]} Angebote`,
        },
        grid: { left: 10, right: 20, top: 10, bottom: 55, containLabel: true },
        xAxis: { type: 'category', data: months.map(m => MONTH_NAMES[m]), axisLabel: { color: '#888' }, splitArea: { show: true } },
        yAxis: { type: 'category', data: cats, axisLabel: { color: '#aaa', fontSize: 11 }, splitArea: { show: true } },
        visualMap: {
            min: 0, max: maxV || 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 5,
            inRange: { color: ['#10261a', '#1e5631', '#4caf50', '#ffee58'] },
            textStyle: { color: '#888' },
        },
        series: [{
            type: 'heatmap', data: cells,
            label: { show: false },
            emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
        }],
    }, { notMerge: true });
}

init().catch(showLoadError);
