// Shared Grundpreis (EUR/unit) logic — loaded by table.html, prospekt.html and
// dashboard.html before their own scripts, exactly like detail-card.js.
//
// This lives in one file on purpose. It is a faithful port of
// scripts/build_indexes.py, and every copy of it is a place the two can drift
// apart silently: a productKey off by one character yields zero history
// lookups, so price badges simply stop appearing with no error anywhere.
// scripts/test_parity.py loads THIS file and compares it against the Python
// side over every offer in data/.
//
// The face price, sanity-capped: a real data-entry outlier (a EUR 47,150
// Camembert) would otherwise poison every derived Grundpreis.
const FACE_MAX = 500;
function offerPrice(o) {
    const raw = o && o.price ? o.price.rawValue : undefined;
    const v = Number.isFinite(raw) ? raw : parseFloat(o && o.price ? o.price.value : NaN);
    return (Number.isFinite(v) && v >= 0 && v <= FACE_MAX) ? v : null;
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

// { val, unit, flag, low } for the Grundpreis, or all-null. flag: exact|range|lower.
// `low` is the optimistic lower-bound comparable: same as val for exact/lower
// (an "ab €" price has only one number, which already is the lower bound), and
// the smaller of the two range values for range ("€ X / € Y" — X isn't always
// the smaller one, see build_indexes.py's parse_gp).
function parseGp(offer) {
    for (const src of [offer && offer.basicPrice, offer && offer.description]) {
        const m = GP_RE.exec(gpNormStr(src));
        if (!m) continue;
        const val = parseNumberDe(m[3]);
        if (!Number.isFinite(val)) continue;
        const flag = m[2] ? 'lower' : (m[4] ? 'range' : 'exact');
        const unit = m[1].toLowerCase();
        let low = val;
        if (flag === 'range') {
            const val2 = parseNumberDe(m[4]);
            if (Number.isFinite(val2)) low = Math.min(val, val2);
        }
        return { val, unit: UNIT_DISPLAY[unit] || unit, flag, low };
    }
    return { val: null, unit: null, flag: null, low: null };
}

// Guards + all-matches variants for deriveGp — see build_indexes.derive_gp for
// why multipacks and loose goods are skipped rather than special-cased.
const MULT_RE = /\d\s*[x×]\s*\d|\bà\b/i;
const LOOSE_RE = /offen/i;
const SIZE_ALL_RE = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\b/gi;
const COUNT_ALL_RE = /(\d+(?:[.,]\d+)?)\s*(WA|Tabs?|Caps?|St(?:ü|ue)ck|Stk|WL)\b/gi;
const COUNT_UNIT = {
    'stück': 'st', 'stueck': 'st', 'stk': 'st', 'st': 'st',
    'wl': 'wa', 'wa': 'wa', 'tab': 'tab', 'cap': 'tab',
};

// { val, unit } from face price ÷ the single pack size stated in `text`, or
// all-null when `text` is missing, guarded, or ambiguous.
function deriveFromText(text, face) {
    const t = gpNormStr(text);
    if (!t || MULT_RE.test(t) || LOOSE_RE.test(t)) return { val: null, unit: null };

    const sizes = [...t.matchAll(SIZE_ALL_RE)];
    if (sizes.length === 1) {
        const val = parseNumberDe(sizes[0][1]);
        const unit = sizes[0][2].toLowerCase();
        const base = val * VOL_WEIGHT_FACTOR[unit];
        if (!Number.isFinite(base) || base <= 0) return { val: null, unit: null };
        return {
            val: Math.round((face / base) * 100) / 100,
            unit: (unit === 'ml' || unit === 'l') ? 'l' : 'kg',
        };
    }
    // Count-priced goods only when no weight/volume is present at all —
    // "20 Stück = 1000 g Beutel" must use the weight, not the count.
    if (!sizes.length) {
        const counts = [...t.matchAll(COUNT_ALL_RE)];
        if (counts.length === 1) {
            const val = parseNumberDe(counts[0][1]);
            if (!Number.isFinite(val) || val <= 0) return { val: null, unit: null };
            const key = COUNT_UNIT[counts[0][2].toLowerCase().replace(/s$/, '')]
                || counts[0][2].toLowerCase();
            return { val: Math.round((face / val) * 100) / 100, unit: UNIT_DISPLAY[key] || key };
        }
    }
    return { val: null, unit: null };
}

// { val, unit } computed from face price / pack size, or all-null. EDEKA omits
// the Grundpreis where the pack already IS the base unit ("1 kg Schale"), which
// is 26% of offers — deriving it is what gives Möhren, Porree and Bananen a
// price history at all. Port of build_indexes.derive_gp; keep the two in sync.
//
// baseUnit first, then description: ~2500 offers carry no baseUnit at all and
// state the pack size only in prose ("Klasse I, 1 kg", "je 1 l Packung"). Those
// were dropped entirely. Falling back to the description is safe — checked
// against the 1083 offers where BOTH texts yield a size, the two agree 100%.
// Note this cannot fire when a Grundpreis is quoted: that quote ("1 kg = € X")
// itself contains a measurement, so the description then holds two and the
// ambiguity guard declines.
function deriveGp(offer) {
    const face = offerPrice(offer);
    if (!Number.isFinite(face) || face <= 0) return { val: null, unit: null };
    const fromBase = deriveFromText(offer && offer.baseUnit, face);
    if (fromBase.val !== null) return fromBase;
    return deriveFromText(offer && offer.description, face);
}

// EDEKA's own Grundpreis when present, else one derived from the pack size.
// `derived` tells the card to label it as computed rather than quoted.
function resolveGp(offer) {
    const parsed = parseGp(offer);
    if (parsed.val !== null) return { ...parsed, derived: false };
    const d = deriveGp(offer);
    if (d.val === null) return { val: null, unit: null, flag: null, low: null, derived: false };
    return { val: d.val, unit: d.unit, flag: 'exact', low: d.val, derived: true };
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
