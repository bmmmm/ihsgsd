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

// Numeric price with a safe fallback that does not coerce a real 0.00.
function offerPrice(o) {
    return Number.isFinite(o.price.rawValue)
        ? o.price.rawValue
        : (parseFloat(o.price.value) || 0);
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
    buildFiltersBar();

    if (files.length > 0) {
        await loadWeek(files[0]);
    }

    renderTrend();
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

async function loadWeek(filePath) {
    try {
        const data = await fetchJSON(`data/${filePath}`);
        const { offers, totalCount, validFrom, validTill } = data;
        currentOffers = offers;

        document.getElementById('info-bar').textContent =
            `${totalCount} Angebote vom ${formatDate(validFrom)} bis ${formatDate(validTill)}`;

        renderFilteredWeekCharts();
    } catch (err) {
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

    const totalProducts = offers.length;
    const categories = new Set(offers.map(o => o.category.name)).size;
    const prices = offers.map(offerPrice);
    const avgPrice = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : '0.00';

    row.appendChild(buildStatCard(totalProducts, 'Produkte'));
    row.appendChild(buildStatCard(categories, 'Kategorien'));
    row.appendChild(buildStatCard(`${avgPrice} €`, 'Ø Preis'));

    // Superknüller count, grouped with the other flat KPIs (was a separate
    // card injected after the wide "Teuerster" card on every feature render).
    const knullerCard = buildStatCard(String(offers.filter(isKnuller).length), 'Superknüller');
    knullerCard.querySelector('.stat-value').style.color = '#ff3b6b';
    row.appendChild(knullerCard);

    if (offers.length > 0) {
        // Build the most-expensive card via DOM API so untrusted
        // titles/URLs can never break out of an attribute.
        const mostExpensive = offers.reduce((max, o) => {
            const p = offerPrice(o);
            return p > max.price ? { offer: o, price: p } : max;
        }, { offer: null, price: -Infinity });
        const o = mostExpensive.offer;

        const card = document.createElement('div');
        card.className = 'stat-card stat-card-expensive';

        const img = buildOfferImage(o);
        if (img) card.appendChild(img);

        const details = document.createElement('div');
        details.className = 'stat-details';

        const value = document.createElement('div');
        value.className = 'stat-value';
        value.textContent = `${mostExpensive.price.toFixed(2)} €`;

        const product = document.createElement('div');
        product.className = 'stat-product';
        product.title = o.title;
        product.textContent = o.title;

        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = 'Teuerster Artikel';

        details.append(value, product, label);
        card.appendChild(details);
        row.appendChild(card);
    }
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
        const price = offerPrice(o);
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
                    return `<b>${name}</b><br/>${params.data.value.toFixed(2)} €`;
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
        if (!catData[cat]) catData[cat] = { count: 0, totalPrice: 0 };
        catData[cat].count++;
        catData[cat].totalPrice += offerPrice(o);
    });

    const treeData = Object.entries(catData).map(([name, d]) => ({
        name: `${name}\n${d.count} Produkte`,
        value: d.count,
        itemStyle: { color: CATEGORY_COLORS[name] || '#888' },
        avgPrice: (d.totalPrice / d.count).toFixed(2),
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
    if (allTrendData.length === 0) return;

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
        if (!(e.ctrlKey || e.metaKey)) return;
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
    price.textContent = offerPrice(o).toFixed(2) + ' €';
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

    // Single sort (O(n log n)); reuse for both ends.
    const sorted = base.slice().sort((a, b) => offerPrice(a) - offerPrice(b));
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
        const exd = p.obs
            .filter(o => o.gpf === undefined)
            .map(o => [o.d, o.gp])
            .sort((a, b) => a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0));
        const g = exd.map(x => x[1]);
        p._ex = g;
        p._min = g.length ? Math.min(...g) : null;
        p._med = medianOf(g);
        p._exWeeks = new Set(exd.map(x => x[0])).size;
        // Offer-price erosion: median of the later half vs the earlier
        // half of this article's exact Grundpreise. Needs >=4 points.
        if (g.length >= 4) {
            const half = Math.floor(g.length / 2);
            const oldM = medianOf(g.slice(0, half));
            const newM = medianOf(g.slice(g.length - half));
            p._oldM = oldM;
            p._newM = newM;
            p._erosion = (oldM && newM) ? (newM / oldM - 1) : null;
        } else {
            p._erosion = null;
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

    const cands = [];
    for (const p of priceHistory.products) {
        if (!activeCategories.has(p.cat)) continue;
        if (p._ex.length < 3) continue; // need history to judge a deal
        const cur = currentExactGp(p, date);
        if (cur === null) continue;
        const over = p._min > 0 ? (cur / p._min - 1) : 0;
        cands.push({ p, cur, over });
    }

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
            priceText: `€${d.cur.toFixed(2)}/${d.p.unit}`,
            badgeText,
            badgeClass,
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
                priceText: `${pct > 0 ? '+' : ''}${pct}%`,
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
function populateGpPicker() {
    const sel = document.getElementById('gp-picker');
    if (!sel || !priceHistory) return;
    // Only articles with >=3 exact weeks give a meaningful line.
    // products is already sorted by history depth (deepest first).
    const pickable = priceHistory.products
        .map((p, idx) => ({ p, idx }))
        .filter(x => x.p._exWeeks >= 3);

    sel.innerHTML = '';
    pickable.forEach(({ p, idx }) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = `${p.title} (${p.cat || '—'}, ${p._exWeeks} Wo.)`;
        sel.appendChild(opt);
    });

    sel.addEventListener('change', () => {
        const p = priceHistory.products[Number(sel.value)];
        if (p) renderGpTrend(p);
    });

    if (pickable.length) {
        sel.value = String(pickable[0].idx);
        renderGpTrend(pickable[0].p);
    }
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

init().catch(showLoadError);
