// Shared product detail card (modal) — opened by clicking an article on any
// page (table.html, dashboard.html, prospekt.html). Shows everything the
// price-history index knows about one article: Grundpreis time series (SVG
// line chart), all-time low / median, offer frequency, and the raw offer
// history. Data source: data/price-history-index.json (lazy-loaded once).
//
// Zero dependencies, injects its own CSS. Public API:
//   DetailCard.open({ title, category, color, date, offer })
//     title    (string, required) — article title to look up in the history
//     category (string, optional) — category name for the header line
//     color    (string, optional) — category dot color (page palettes differ)
//     date     ("YYYY-MM-DD", optional) — the page's selected week; that
//               week's observation is highlighted in the chart
//     offer    (object, optional) — the clicked week-offer for the header:
//               { price, basicPrice, description, imageUrl, localImageUrl }
window.DetailCard = (function () {
    'use strict';

    const EPS = 1e-9;
    let indexPromise = null;   // fetch-once cache
    let byTitle = null;        // Map<normTitle, product[]>
    let weeks = [];            // all snapshot dates, sorted
    let root = null;           // modal DOM, built once

    function norm(s) {
        return String(s || '').replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function fmtDate(d) {
        const p = String(d || '').split('-');
        return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
    }

    function fmtEuro(v) {
        return v === null || v === undefined ? '—' : v.toFixed(2).replace('.', ',') + ' €';
    }

    function ensureIndex() {
        if (!indexPromise) {
            indexPromise = fetch('data/price-history-index.json')
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(idx => {
                    weeks = Array.isArray(idx.weeks) ? idx.weeks : [];
                    byTitle = new Map();
                    (idx.products || []).forEach(p => {
                        const k = norm(p.title);
                        if (!byTitle.has(k)) byTitle.set(k, []);
                        byTitle.get(k).push(p);
                    });
                })
                .catch(err => {
                    console.error('DetailCard: price history load failed:', err);
                    byTitle = new Map();
                });
        }
        return indexPromise;
    }

    // One exact Grundpreis per distinct week (min of that week's exact obs) —
    // same collapsing rule dashboard.js/prospekt.js use for their stats.
    function perWeekExact(prod) {
        const m = new Map();
        for (const o of prod.obs) {
            if (o.gpf !== undefined) continue;
            const cur = m.get(o.d);
            m.set(o.d, cur === undefined ? o.gp : Math.min(cur, o.gp));
        }
        return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
            .map(([d, gp]) => ({ d, gp }));
    }

    function medianOf(arr) {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // ── modal shell ──
    function buildRoot() {
        const style = document.createElement('style');
        style.textContent = `
.dcard-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(3px);z-index:9990;display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px 16px;overflow-y:auto}
.dcard{background:#161616;border:1px solid #2e2e2e;border-radius:16px;max-width:640px;width:100%;color:#e0e0e0;font-family:'Segoe UI',Arial,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden}
.dcard-head{display:flex;gap:14px;padding:18px 20px 14px;border-bottom:1px solid #262626;align-items:flex-start}
.dcard-img{width:72px;height:72px;flex:0 0 72px;border-radius:10px;background:#222;object-fit:contain}
.dcard-head-body{flex:1;min-width:0}
.dcard-title{font-size:1.15rem;font-weight:700;color:#fff;line-height:1.3}
.dcard-cat{display:flex;align-items:center;gap:6px;color:#999;font-size:.85rem;margin-top:4px}
.dcard-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.dcard-close{background:none;border:none;color:#888;font-size:1.5rem;cursor:pointer;line-height:1;padding:2px 6px;border-radius:8px}
.dcard-close:hover{color:#fff;background:#262626}
.dcard-offer{padding:12px 20px;border-bottom:1px solid #262626;font-size:.9rem;color:#bbb}
.dcard-offer .dcard-price{font-size:1.3rem;font-weight:700;color:#4caf50;margin-right:10px}
.dcard-offer .dcard-gp{color:#999}
.dcard-desc{margin-top:6px;color:#8a8a8a;font-size:.8rem;line-height:1.4}
.dcard-body{padding:14px 20px 20px}
.dcard-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.dcard-tab{background:#222;border:1px solid #333;color:#bbb;border-radius:999px;padding:4px 12px;font-size:.8rem;cursor:pointer}
.dcard-tab.on{background:#2e4632;border-color:#4caf50;color:#dfffe2}
.dcard-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0}
.dcard-stat{background:#1d1d1d;border:1px solid #2a2a2a;border-radius:10px;padding:8px 10px}
.dcard-stat .v{font-size:1.05rem;font-weight:700;color:#fff}
.dcard-stat .v.low{color:#66bb6a}
.dcard-stat .v.high{color:#ff7961}
.dcard-stat .l{font-size:.72rem;color:#888;margin-top:2px;line-height:1.3}
.dcard-badge{display:inline-block;border-radius:999px;padding:3px 10px;font-size:.78rem;font-weight:600;margin-left:8px;vertical-align:middle}
.dcard-badge.best{background:#1e3a24;color:#7ee787;border:1px solid #2e7d32}
.dcard-badge.over{background:#3a2a1e;color:#ffb74d;border:1px solid #8d6e63}
.dcard-chart{width:100%;height:auto;display:block;margin:6px 0 2px;background:#131313;border:1px solid #262626;border-radius:10px}
.dcard-chart-hint{font-size:.72rem;color:#777;margin-bottom:10px}
.dcard-sec{font-size:.8rem;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px}
.dcard-hist{list-style:none;margin:0;padding:0;max-height:200px;overflow-y:auto}
.dcard-hist li{display:flex;justify-content:space-between;gap:10px;padding:5px 2px;border-bottom:1px solid #222;font-size:.85rem}
.dcard-hist .d{color:#999}
.dcard-hist .this-week .d{color:#4caf50;font-weight:600}
.dcard-hist .k{color:#ff3b6b;font-size:.72rem;font-weight:700;margin-left:6px}
.dcard-hist .p{color:#ddd;white-space:nowrap}
.dcard-empty{color:#999;font-size:.9rem;padding:14px 0;line-height:1.5}
@media (max-width:520px){.dcard-head{padding:14px 14px 10px}.dcard-body{padding:12px 14px 16px}.dcard-offer{padding:10px 14px}}`;
        document.head.appendChild(style);

        root = document.createElement('div');
        root.className = 'dcard-backdrop';
        root.style.display = 'none';
        const card = document.createElement('div');
        card.className = 'dcard';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        root.appendChild(card);
        document.body.appendChild(root);

        root.addEventListener('click', e => { if (e.target === root) close(); });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && root.style.display !== 'none') close();
        });
        return card;
    }

    function close() {
        if (root) root.style.display = 'none';
        document.body.style.overflow = '';
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function stat(value, label, cls) {
        const s = el('div', 'dcard-stat');
        const v = el('div', 'v' + (cls ? ' ' + cls : ''), value);
        s.appendChild(v);
        s.appendChild(el('div', 'l', label));
        return s;
    }

    // ── SVG Grundpreis chart ──
    function buildChart(prod, selectedDate) {
        const NS = 'http://www.w3.org/2000/svg';
        const W = 600, H = 190, PAD = { l: 46, r: 12, t: 14, b: 26 };
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('class', 'dcard-chart');

        const exact = perWeekExact(prod);
        const fuzzy = prod.obs.filter(o => o.gpf !== undefined);
        const all = exact.map(o => o.gp).concat(fuzzy.map(o => o.gp));
        if (!all.length) return null;

        const t0 = Date.parse(exact.length ? exact[0].d : fuzzy[0].d);
        const t1 = Date.parse(exact.length ? exact[exact.length - 1].d : fuzzy[fuzzy.length - 1].d);
        const span = Math.max(t1 - t0, 1);
        let yMin = Math.min(...all), yMax = Math.max(...all);
        if (yMax - yMin < 0.05) { yMin -= 0.05; yMax += 0.05; }
        const yPad = (yMax - yMin) * 0.12;
        yMin -= yPad; yMax += yPad;

        const x = d => PAD.l + (Date.parse(d) - t0) / span * (W - PAD.l - PAD.r);
        const y = v => H - PAD.b - (v - yMin) / (yMax - yMin) * (H - PAD.t - PAD.b);

        const line = (x1, y1, x2, y2, stroke, dash) => {
            const l = document.createElementNS(NS, 'line');
            l.setAttribute('x1', x1); l.setAttribute('y1', y1);
            l.setAttribute('x2', x2); l.setAttribute('y2', y2);
            l.setAttribute('stroke', stroke);
            l.setAttribute('stroke-width', '1');
            if (dash) l.setAttribute('stroke-dasharray', dash);
            svg.appendChild(l);
        };
        const text = (tx, ty, str, anchor, fill) => {
            const t = document.createElementNS(NS, 'text');
            t.setAttribute('x', tx); t.setAttribute('y', ty);
            t.setAttribute('font-size', '10');
            t.setAttribute('fill', fill || '#777');
            if (anchor) t.setAttribute('text-anchor', anchor);
            t.textContent = str;
            svg.appendChild(t);
        };

        // y axis: min / max gridlines + all-time-low dashed line
        const gpMin = Math.min(...all);
        line(PAD.l, y(yMax), PAD.l, H - PAD.b, '#333');
        line(PAD.l, H - PAD.b, W - PAD.r, H - PAD.b, '#333');
        text(PAD.l - 5, y(yMax - yPad) + 3, fmtEuro(Math.max(...all)), 'end');
        text(PAD.l - 5, y(gpMin) + 3, fmtEuro(gpMin), 'end', '#66bb6a');
        line(PAD.l, y(gpMin), W - PAD.r, y(gpMin), '#2e7d32', '4 4');
        // x axis: first / last date
        text(PAD.l, H - 8, fmtDate(exact.length ? exact[0].d : fuzzy[0].d));
        text(W - PAD.r, H - 8, fmtDate(exact.length ? exact[exact.length - 1].d : fuzzy[fuzzy.length - 1].d), 'end');

        // exact series: polyline + dots
        if (exact.length > 1) {
            const pl = document.createElementNS(NS, 'polyline');
            pl.setAttribute('points', exact.map(o => `${x(o.d)},${y(o.gp)}`).join(' '));
            pl.setAttribute('fill', 'none');
            pl.setAttribute('stroke', '#4caf50');
            pl.setAttribute('stroke-width', '1.5');
            svg.appendChild(pl);
        }
        const dot = (o, hollow) => {
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('cx', x(o.d)); c.setAttribute('cy', y(o.gp));
            const isSel = selectedDate && o.d === selectedDate;
            c.setAttribute('r', isSel ? '5' : '3.2');
            if (hollow) {
                c.setAttribute('fill', '#131313');
                c.setAttribute('stroke', '#8d6e63');
                c.setAttribute('stroke-width', '1.5');
            } else {
                c.setAttribute('fill', isSel ? '#fff176' : '#4caf50');
            }
            const tip = document.createElementNS(NS, 'title');
            tip.textContent = `${fmtDate(o.d)} — ${fmtEuro(o.gp)}/${prod.unit}` + (hollow ? ' (ab-Preis/Spanne)' : '');
            c.appendChild(tip);
            svg.appendChild(c);
        };
        fuzzy.forEach(o => dot(o, true));
        exact.forEach(o => dot(o, false));
        return svg;
    }

    // ── per-variant panel (stats + chart + history list) ──
    function buildVariantPanel(prod, selectedDate) {
        const wrap = el('div');
        const exact = perWeekExact(prod);
        const gps = exact.map(o => o.gp);
        const distinctWeeks = new Set(prod.obs.map(o => o.d));
        const firstD = prod.obs[0].d;
        const lastD = prod.obs[prod.obs.length - 1].d;
        const min = gps.length ? Math.min(...gps) : null;
        const max = gps.length ? Math.max(...gps) : null;
        const med = medianOf(gps);
        const latest = gps.length ? exact[exact.length - 1] : null;

        // headline badge: is the latest exact Grundpreis the all-time low?
        const sec = el('div', 'dcard-sec', `Grundpreis-Statistik (€/${prod.unit})`);
        if (latest && min !== null) {
            if (latest.gp <= min + EPS) {
                sec.appendChild(el('span', 'dcard-badge best', 'Allzeit-Tief'));
            } else if (min > 0) {
                const pct = Math.round((latest.gp / min - 1) * 100);
                if (pct >= 1) sec.appendChild(el('span', 'dcard-badge over', `+${pct}% über Tief`));
            }
        }
        wrap.appendChild(sec);

        const grid = el('div', 'dcard-stats');
        if (latest) grid.appendChild(stat(fmtEuro(latest.gp), `Zuletzt (${fmtDate(latest.d)})`));
        if (min !== null) {
            const minD = exact.find(o => o.gp <= min + EPS);
            grid.appendChild(stat(fmtEuro(min), `Allzeit-Tief (${minD ? fmtDate(minD.d) : '—'})`, 'low'));
        }
        if (med !== null) grid.appendChild(stat(fmtEuro(med), 'Median'));
        if (max !== null) grid.appendChild(stat(fmtEuro(max), 'Höchster', 'high'));
        grid.appendChild(stat(String(distinctWeeks.size), `Wochen im Angebot seit ${fmtDate(firstD)}`));
        const weeksSince = weeks.filter(w => w > lastD).length;
        grid.appendChild(stat(
            weeksSince === 0 ? 'diese Woche' : `vor ${weeksSince} Wo.`,
            `Zuletzt im Angebot (${fmtDate(lastD)})`
        ));
        wrap.appendChild(grid);

        const chart = buildChart(prod, selectedDate);
        if (chart) {
            wrap.appendChild(chart);
            wrap.appendChild(el('div', 'dcard-chart-hint',
                'Grundpreis pro Angebotswoche. Hohle Punkte: „ab"-Preis oder Preisspanne (nicht in der Statistik). Gestrichelt: Allzeit-Tief.'));
        }

        wrap.appendChild(el('div', 'dcard-sec', 'Angebots-Historie'));
        const ul = el('ul', 'dcard-hist');
        [...prod.obs].reverse().slice(0, 30).forEach(o => {
            const li = el('li');
            if (selectedDate && o.d === selectedDate) li.className = 'this-week';
            const left = el('span', 'd', fmtDate(o.d));
            if (o.k) left.appendChild(el('span', 'k', 'KNÜLLER'));
            li.appendChild(left);
            const gpTxt = `${fmtEuro(o.gp)}/${prod.unit}` + (o.gpf !== undefined ? ' (ab)' : '');
            li.appendChild(el('span', 'p',
                o.face !== undefined ? `${fmtEuro(o.face)} · ${gpTxt}` : gpTxt));
            ul.appendChild(li);
        });
        wrap.appendChild(ul);
        return wrap;
    }

    function render(card, payload, matches) {
        card.innerHTML = '';

        // header
        const head = el('div', 'dcard-head');
        const offer = payload.offer || {};
        const imgSrc = offer.localImageUrl || offer.imageUrl || '';
        if (imgSrc) {
            const img = el('img', 'dcard-img');
            img.alt = '';
            img.src = imgSrc;
            if (offer.localImageUrl && offer.imageUrl) {
                img.onerror = function () { this.onerror = () => this.remove(); this.src = offer.imageUrl; };
            } else {
                img.onerror = function () { this.remove(); };
            }
            head.appendChild(img);
        }
        const hb = el('div', 'dcard-head-body');
        hb.appendChild(el('div', 'dcard-title', payload.title || '(ohne Titel)'));
        if (payload.category) {
            const cat = el('div', 'dcard-cat');
            const dotEl = el('span', 'dcard-dot');
            dotEl.style.background = payload.color || '#888';
            cat.appendChild(dotEl);
            cat.appendChild(document.createTextNode(payload.category));
            hb.appendChild(cat);
        }
        head.appendChild(hb);
        const closeBtn = el('button', 'dcard-close', '×');
        closeBtn.setAttribute('aria-label', 'Schließen');
        closeBtn.addEventListener('click', close);
        head.appendChild(closeBtn);
        card.appendChild(head);

        // current-offer block (only when opened from a week offer)
        if (offer.price !== undefined || offer.basicPrice || offer.description) {
            const ob = el('div', 'dcard-offer');
            if (offer.price !== undefined && offer.price !== null) {
                ob.appendChild(el('span', 'dcard-price', fmtEuro(offer.price)));
            }
            if (offer.basicPrice) ob.appendChild(el('span', 'dcard-gp', offer.basicPrice));
            if (offer.description) ob.appendChild(el('div', 'dcard-desc', offer.description));
            card.appendChild(ob);
        }

        const body = el('div', 'dcard-body');
        card.appendChild(body);

        if (!matches.length) {
            body.appendChild(el('div', 'dcard-empty',
                'Keine Preishistorie zu diesem Artikel gefunden. Der Index umfasst nur Artikel, ' +
                'die in mindestens zwei Wochen mit erkennbarem Grundpreis im Angebot waren.'));
            return;
        }

        // variant tabs (same title can exist per unit / size class) — the
        // variant offered in the page's selected week comes first, then depth
        const sel = payload.date || null;
        const hasSel = p => sel && p.obs.some(o => o.d === sel) ? 1 : 0;
        const sorted = [...matches].sort((a, b) =>
            hasSel(b) - hasSel(a) || b.obs.length - a.obs.length);
        const panelHost = el('div');
        const showVariant = prod => {
            panelHost.innerHTML = '';
            panelHost.appendChild(buildVariantPanel(prod, payload.date || null));
        };
        if (sorted.length > 1) {
            const tabs = el('div', 'dcard-tabs');
            sorted.forEach((prod, i) => {
                const bucket = String(prod.key || '').split('|')[2] || '';
                const label = `€/${prod.unit}` +
                    (bucket && bucket !== '?' ? ` · Größe ${bucket}` : '') +
                    ` · ${new Set(prod.obs.map(o => o.d)).size} Wo.`;
                const tab = el('button', 'dcard-tab' + (i === 0 ? ' on' : ''), label);
                tab.type = 'button';
                tab.addEventListener('click', () => {
                    tabs.querySelectorAll('.dcard-tab').forEach(t => t.classList.remove('on'));
                    tab.classList.add('on');
                    showVariant(prod);
                });
                tabs.appendChild(tab);
            });
            body.appendChild(tabs);
        }
        body.appendChild(panelHost);
        showVariant(sorted[0]);
    }

    async function open(payload) {
        if (!payload || !payload.title) return;
        const card = root ? root.querySelector('.dcard') : buildRoot();
        root.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        card.innerHTML = '<div class="dcard-body dcard-empty">Lade Preishistorie…</div>';
        await ensureIndex();
        const matches = byTitle.get(norm(payload.title)) || [];
        render(card, payload, matches);
        root.scrollTop = 0;
    }

    return { open, close };
})();
