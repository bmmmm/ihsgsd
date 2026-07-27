/* Layout regression probe — paste into the browser console on any page of the
 * site (same origin required), then:
 *
 *     await layoutProbe()                     // all pages, 390 / 768 / 1280
 *     await layoutProbe(['prospekt.html'], [1512, 560])
 *
 * Reports three classes of defect that CSS review alone keeps missing:
 *
 *   1. hardBreaks — a word torn across lines because its box is narrower than
 *      the word itself ("Mö/hre/n" in a 35px box). Measured with the Range API:
 *      a word whose client rects sit on more than one line, where the longest
 *      hyphen-free segment does not fit the box. Breaks AT a hyphen are normal
 *      German typography and are counted separately as softBreaks.
 *   2. overflowPx — content wider than the viewport (horizontal scrolling).
 *   3. smallTargets — interactive elements below 44x44 CSS px, the threshold
 *      below which touch input gets unreliable. Only meaningful for the coarse-
 *      pointer case; the pages keep desktop density under a fine pointer.
 *
 * No build step and no dependency, matching the rest of the repo. Each page is
 * loaded in an off-screen iframe, so media queries resolve against the probe
 * width rather than the real window — which is the whole point: the shopping
 * list tore words at 1280px and was perfectly fine at 390px.
 */
(function () {
  const PAGES = ['index.html', 'prospekt.html', 'table.html', 'dashboard.html'];
  const WIDTHS = [390, 768, 1280];
  const TARGET_MIN = 44;
  const SETTLE_MS = 2500;   // the pages fetch their week JSON after load

  function selectorOf(el) {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  }

  function scanBreaks(doc) {
    const hard = [], soft = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const el = node.parentElement;
      if (!el || !el.offsetParent) continue;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text))) {
        const word = m[0];
        if (word.length < 4) continue;
        const range = doc.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + word.length);
        const lines = new Set([...range.getClientRects()].map(r => Math.round(r.top)));
        if (lines.size < 2) continue;
        const boxW = Math.round(el.getBoundingClientRect().width);
        // A word split by the browser's hyphenation dictionary is correct
        // typography, not a defect — it renders with a visible hyphen. The
        // inserted hyphen is not in the text content, so it cannot be detected
        // from the string; the computed style is the honest signal.
        if (doc.defaultView.getComputedStyle(el).hyphens === 'auto') {
          soft.push({ word, sel: selectorOf(el), boxW, neededPx: boxW });
          continue;
        }
        // Longest chunk that cannot legitimately be split.
        const longest = word.split(/[-–/]/).reduce((a, b) => (a.length >= b.length ? a : b), '');
        const probe = doc.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
        probe.textContent = longest;
        el.appendChild(probe);
        const needed = probe.getBoundingClientRect().width;
        probe.remove();
        const entry = { word, sel: selectorOf(el), boxW, neededPx: Math.round(needed) };
        (needed > boxW + 1 ? hard : soft).push(entry);
      }
    }
    return { hard, soft };
  }

  // Visible area of an element: its rect clipped by every scrolling/hidden
  // ancestor. Without the clipping step an element that merely sits outside its
  // scroll container's viewport reads as overlapping whatever is next to it —
  // which produced a run of false positives on the jump bar.
  function visibleRect(el, doc, win) {
    let r = el.getBoundingClientRect();
    let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    let p = el.parentElement;
    while (p && p !== doc.body) {
      const st = win.getComputedStyle(p);
      if (/auto|scroll|hidden/.test(st.overflowX + st.overflowY)) {
        const pr = p.getBoundingClientRect();
        box = {
          left: Math.max(box.left, pr.left), right: Math.min(box.right, pr.right),
          top: Math.max(box.top, pr.top), bottom: Math.min(box.bottom, pr.bottom),
        };
      }
      p = p.parentElement;
    }
    return box;
  }

  // Controls that visually cover each other. This is the class of defect that
  // slipped through review: a position:sticky counter inside a horizontally
  // scrolling bar rendered on top of the links it had scrolled past, and its
  // translucent background showed both labels at once.
  function scanOverlaps(doc, win) {
    const groups = ['.pk-jump', '.header', '.header-controls', '.steer-bar', '.pk-sl-item'];
    const hits = [];
    for (const g of groups) {
      for (const container of doc.querySelectorAll(g)) {
        const kids = [...container.querySelectorAll('a, button, select, input, label')]
          .filter(e => e.offsetParent)
          .map(e => ({ el: e, r: visibleRect(e, doc, win) }))
          .filter(x => x.r.right - x.r.left > 1 && x.r.bottom - x.r.top > 1);
        for (let i = 0; i < kids.length; i++) {
          for (let j = i + 1; j < kids.length; j++) {
            if (kids[i].el.contains(kids[j].el) || kids[j].el.contains(kids[i].el)) continue;
            const a = kids[i].r, b = kids[j].r;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 1 && oy > 1) {
              hits.push(`${g}: "${kids[i].el.textContent.trim().slice(0, 18)}" over `
                + `"${kids[j].el.textContent.trim().slice(0, 18)}" (${Math.round(ox)}x${Math.round(oy)}px)`);
            }
          }
        }
      }
    }
    return hits;
  }

  function scanTargets(doc) {
    const small = {};
    const sel = 'button, a, input, select, textarea, [role="button"], label';
    for (const el of doc.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !el.offsetParent) continue;
      if (r.height >= TARGET_MIN && r.width >= TARGET_MIN) continue;
      const key = selectorOf(el);
      if (!small[key]) small[key] = { count: 0, size: `${Math.round(r.width)}x${Math.round(r.height)}` };
      small[key].count++;
    }
    return small;
  }

  async function probe(page, width) {
    const f = document.createElement('iframe');
    f.style.cssText =
      `width:${width}px;height:2600px;position:fixed;left:-9999px;top:0;border:0`;
    f.src = page;
    document.body.appendChild(f);
    await new Promise(res => { f.onload = res; setTimeout(res, 8000); });
    await new Promise(res => setTimeout(res, SETTLE_MS));
    let out;
    try {
      const doc = f.contentDocument;
      const { hard, soft } = scanBreaks(doc);
      const overlaps = scanOverlaps(doc, f.contentWindow);
      out = {
        page, width,
        hardBreaks: hard.length,
        details: hard.slice(0, 6).map(h => `${h.word} @ ${h.sel} (box ${h.boxW}px < ${h.neededPx}px)`),
        softBreaks: soft.length,
        overlaps: overlaps.length,
        overlapDetails: overlaps.slice(0, 6),
        overflowPx: Math.max(0, doc.documentElement.scrollWidth - doc.documentElement.clientWidth),
        smallTargets: scanTargets(doc),
      };
    } finally {
      f.remove();
    }
    return out;
  }

  window.layoutProbe = async function (pages = PAGES, widths = WIDTHS) {
    const rows = [];
    for (const p of pages) for (const w of widths) rows.push(await probe(p, w));
    const broken = rows.filter(r => r.hardBreaks || r.overflowPx || r.overlaps);
    console.table(rows.map(r => ({
      page: r.page, width: r.width, hardBreaks: r.hardBreaks, overlaps: r.overlaps,
      overflowPx: r.overflowPx, softBreaks: r.softBreaks,
      smallTargetKinds: Object.keys(r.smallTargets).length,
    })));
    for (const r of rows) {
      if (r.details.length) console.warn(`${r.page} @${r.width}px torn words:`, r.details);
      if (r.overlapDetails.length) console.warn(`${r.page} @${r.width}px overlapping controls:`, r.overlapDetails);
    }
    console.log(broken.length
      ? `FAIL: ${broken.length} page/width combination(s) with torn words, overlap or overflow.`
      : 'PASS: no torn words, no overlapping controls, no horizontal overflow.');
    return rows;
  };
  console.log('layoutProbe() ready — run: await layoutProbe()');
})();
