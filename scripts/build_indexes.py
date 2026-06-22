#!/usr/bin/env python3
"""Build the dashboard's precomputed index files from the weekly snapshots.

Single source of truth for cross-week analytics. Replaces the inline jq step
that produced trend-index.json, and additionally derives a per-product price
history so the dashboard can answer "was this ever cheaper?" without loading
all ~17 MB of weekly JSON in the browser.

Outputs (written into data/):
  - trend-index.json          per-week aggregates (category counts + KPIs)
  - price-history-index.json  per-product Grundpreis (€/unit) time series

The face price (price.rawValue) is NOT comparable across weeks for the same
title (pack-size swaps make it jump), so cross-week comparison uses the
Grundpreis (€/kg, €/l, …). The native basicPrice field is populated in only a
minority of weeks, but the same value is embedded in the description text for
~73% of all offers across every week — so we recover it from there too.

stdlib only; runs under the Python preinstalled on GitHub-hosted runners.
"""
import json
import glob
import math
import os
import re
import statistics
import sys

DATA_DIR = "data"
# Same set the jq step matched: data/<year>/KW<n>/<date>.json
FILE_GLOB = os.path.join(DATA_DIR, "[0-9]" * 4, "KW*", "*.json")

# A real data-entry outlier (a €47,150 Camembert) poisons every face-price
# mean/distribution; drop any face above this sane ceiling.
FACE_MAX = 500.0

# Grundpreis: "1 kg = € 12.50", "1 l = ab € 0.12", "1 l = € 15.27 / € 45.80".
# Matches the native basicPrice and the "(… )" form embedded in description.
GP_RE = re.compile(
    r"1\s*([A-Za-z]{1,3})\s*=\s*(ab\s*)?€\s*([\d.,]+)(?:\s*/\s*€\s*([\d.,]+))?"
)
# First measurement in a baseUnit string, e.g. "je 250 ml Flasche" -> 250 ml.
SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\b", re.IGNORECASE)
# Count-based size, e.g. "je 36 - 64 Tabs", "27 WA", "16 - 36 Stück". Used as a
# size class for products priced per wash-load / tab / piece, which carry no
# ml/l/g/kg in baseUnit and would otherwise all collapse into the "?" bucket.
COUNT_RE = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(WA|Tabs?|Caps?|St(?:ü|ue)ck|Stk|WL)\b", re.IGNORECASE
)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
WEEK_RE = re.compile(r"(\d{4})/(KW\d+)/")
VOL_WEIGHT_FACTOR = {"ml": 0.001, "l": 1.0, "g": 0.001, "kg": 1.0}
# Display-canonical Grundpreis units (kg/l stay lowercase by convention).
UNIT_DISPLAY = {"wa": "WA", "tab": "Tab", "st": "St", "stk": "St"}


def norm(s):
    """Trim and replace the non-breaking spaces EDEKA uses in price strings."""
    return (s or "").replace("\xa0", " ").strip()


def parse_number(s):
    """Parse a price/size number tolerant of German grouping.

    "12.50" -> 12.5, "1,99" -> 1.99, "1.234,56" -> 1234.56. Raises ValueError
    on anything non-numeric so callers can skip it rather than guess.
    """
    s = s.strip()
    if "." in s and "," in s:  # grouped: dot=thousands, comma=decimal
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", ".")
    return float(s)


def parse_gp(offer):
    """(value, unit, flag) for the Grundpreis, or (None, None, None).

    flag is "exact" | "range" (two values given) | "lower" ("ab €" bound).
    Range/lower values are ambiguous and must be excluded from min/percentile
    statistics, but are still useful for plotting a rough trajectory.
    """
    for src in (offer.get("basicPrice"), offer.get("description")):
        m = GP_RE.search(norm(src))
        if not m:
            continue
        try:
            val = parse_number(m.group(3))
        except ValueError:
            continue
        flag = "lower" if m.group(2) else ("range" if m.group(4) else "exact")
        unit = m.group(1).lower()
        return val, UNIT_DISPLAY.get(unit, unit), flag
    return None, None, None


def face_price(offer):
    """price.rawValue if sane, else parsed price.value, else None.

    A `|| fallback` would wrongly coerce the one legitimate rawValue:0 item, so
    we check for an actual finite number first.
    """
    price = offer.get("price") or {}
    raw = price.get("rawValue")
    val = raw if isinstance(raw, (int, float)) else None
    if val is None:
        try:
            val = float(price.get("value"))
        except (TypeError, ValueError):
            return None
    if val < 0 or val > FACE_MAX:
        return None
    return round(float(val), 2)


def norm_title(title):
    return re.sub(r"\s+", " ", norm(title).lower())


def size_bucket(baseunit):
    """Coarse order-of-magnitude size class from baseUnit.

    Separates e.g. a 0.33 l can from a 1.5 l bottle of the same title (both
    €/l) so their Grundpreis series don't get conflated, while keeping minor
    size variants (250 ml vs 300 ml) in the same bucket. Falls back to a
    count-based class (Tabs/WA/Stück) and finally "?" for messy multipack /
    Pfand strings with no parseable measurement."""
    s = norm(baseunit)
    m = SIZE_RE.search(s)
    if m:
        try:
            val = parse_number(m.group(1))
        except ValueError:
            val = 0
        unit = m.group(2).lower()
        base = val * VOL_WEIGHT_FACTOR[unit]
        if base > 0:
            dim = "v" if unit in ("ml", "l") else "w"
            return f"{dim}{int(math.floor(math.log10(base)))}"
    m = COUNT_RE.search(s)
    if m:
        try:
            val = parse_number(m.group(1))
        except ValueError:
            val = 0
        if val > 0:
            return f"c{int(math.floor(math.log10(val)))}"
    return "?"


def product_key(offer, unit):
    """Composite cross-week identity: title + Grundpreis-unit + size class."""
    return f"{norm_title(offer.get('title'))}|{unit}|{size_bucket(offer.get('baseUnit'))}"


def has_criterion(offer, name):
    crit = offer.get("criteria")
    return isinstance(crit, list) and any(
        isinstance(c, dict) and c.get("name") == name for c in crit
    )


def parse_path(path):
    """(week 'YYYY-KW##', date 'YYYY-MM-DD') from a data file path."""
    rel = os.path.relpath(path, DATA_DIR).replace(os.sep, "/")
    wm = WEEK_RE.search(rel)
    dm = DATE_RE.search(rel)
    week = f"{wm.group(1)}-{wm.group(2)}" if wm else rel
    date = dm.group(0) if dm else rel
    return rel, week, date


def median(values):
    return round(statistics.median(values), 2) if values else None


def build():
    files = sorted(glob.glob(FILE_GLOB))
    if not files:
        sys.exit(f"No data files matched {FILE_GLOB!r} — run from the repo root.")

    trend = []
    # key -> {"title","cat","unit","obs":[...]}; obs grow per week.
    products = {}
    all_dates = set()

    # Diagnostics.
    n_offers = n_gp = n_native = 0

    for path in files:
        rel, week, date = parse_path(path)
        all_dates.add(date)
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        offers = data.get("offers", [])

        counts = {}
        faces = []
        knuller = payback = gp_count = 0

        for o in offers:
            n_offers += 1
            cat = (o.get("category") or {}).get("name")
            if cat:
                counts[cat] = counts.get(cat, 0) + 1
            if has_criterion(o, "Superknüller"):
                knuller += 1
            if has_criterion(o, "PAYBACK"):
                payback += 1

            face = face_price(o)
            if face is not None:
                faces.append(face)

            val, unit, flag = parse_gp(o)
            if val is None:
                continue
            gp_count += 1
            n_gp += 1
            if GP_RE.search(norm(o.get("basicPrice"))):
                n_native += 1

            key = product_key(o, unit)
            prod = products.get(key)
            if prod is None:
                prod = products[key] = {"unit": unit, "obs": []}
            # Latest title/category win (most recent wording).
            prod["title"] = o.get("title") or prod.get("title") or "(ohne Titel)"
            prod["cat"] = cat or prod.get("cat")
            ob = {"d": date, "gp": round(val, 2)}
            if flag != "exact":
                ob["gpf"] = flag
            if face is not None:
                ob["face"] = face
            if has_criterion(o, "Superknüller"):
                ob["k"] = 1
            prod["obs"].append(ob)

        trend.append({
            "file": rel,
            "week": week,
            "date": date,
            "total": data.get("totalCount", len(offers)),
            "counts": counts,
            "knuller": knuller,
            "payback": payback,
            "gpCoverage": round(gp_count / len(offers), 3) if offers else 0,
            "avgFace": round(sum(faces) / len(faces), 2) if faces else None,
            "medFace": median(faces),
        })

    trend.sort(key=lambda e: e["date"])

    # Keep only products observed in >=2 distinct weeks — a single-week product
    # has no history to compare against and would only bloat the file.
    history = []
    for key, prod in products.items():
        obs = sorted(prod["obs"], key=lambda x: x["d"])
        if len({x["d"] for x in obs}) < 2:
            continue
        history.append({
            "key": key,
            "title": prod["title"],
            "cat": prod.get("cat"),
            "unit": prod["unit"],
            "obs": obs,
        })
    # Deepest histories first (drives the product picker default order).
    history.sort(key=lambda p: (-len(p["obs"]), p["title"]))

    price_history = {
        "latestDate": max(all_dates),
        "weeks": sorted(all_dates),
        "products": history,
    }

    trend_path = os.path.join(DATA_DIR, "trend-index.json")
    hist_path = os.path.join(DATA_DIR, "price-history-index.json")
    with open(trend_path, "w", encoding="utf-8") as fh:
        json.dump(trend, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    with open(hist_path, "w", encoding="utf-8") as fh:
        json.dump(price_history, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    cov = 100 * n_gp / n_offers if n_offers else 0
    print(f"files={len(files)} offers={n_offers}")
    print(f"GP coverage: {n_gp}/{n_offers} = {cov:.1f}% (native {n_native}, "
          f"from-desc {n_gp - n_native})")
    print(f"trend-index.json: {len(trend)} weeks -> {os.path.getsize(trend_path)//1024} KB")
    print(f"price-history-index.json: {len(history)} products "
          f"(>=2 weeks) -> {os.path.getsize(hist_path)//1024} KB")


if __name__ == "__main__":
    build()
