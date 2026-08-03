#!/usr/bin/env python3
"""Fetch REWE, Lidl and ALDI SUED weekly offers from kaufda (Bonial) into
data-kaufda/<retailer>/<year>/KW<ww>/<monday>.json.

Stdlib only, also runs locally:

    python3 scripts/fetch_kaufda.py [--dry-run]

Unlike the EDEKA/ALDI direct APIs, kaufda's offers are flyer extracts with a
noisy nested shape and no SKUs — so this fetcher NORMALIZES each offer into a
flat record and mints its own stable id: sha1 over (retailer, brand, product
names, description), truncated to 12 hex chars. That id deduplicates regional
flyer editions of the same week and keeps refetches churn-free. The raw Bonial
offer UUID is kept as `kaufdaId` for tracing back to the source.

It does NOT give a price history. Measured across KW31-KW33 2026, consecutive
weeks share 0-1 products out of 400-570 — and matching on brand+name alone,
ignoring the description entirely, only lifts that to 2-10. The flyers simply
reprint different articles each week, so an EDEKA-style per-product history has
nothing to accumulate here. Compare weeks by category or price band instead.

Discovery needs no API seed: the kaufda shelf page (regional, lat/lng) and
the per-retailer store pages are server-side rendered — their __NEXT_DATA__
JSON lists every current brochure with publisher and validFrom. The
content-viewer backend then serves the pages; it wants a browser User-Agent
plus three underscore headers, exactly as its FST_ERR_VALIDATION error names
them (the `bonial-*` header names in the JS bundle are NOT what it checks).

Snapshots are filed under the Monday of the brochure's OWN validFrom week
(like EDEKA's validFrom filing), so an early run is always safe. Guards as in
fetch_aldi.py: retry with backoff, minimum offer count, never shrink,
churn-free rewrite skip. One failing retailer only warns — the next cron run
retries, and audit_data.py flags a week that never arrived.
"""

import argparse
import hashlib
import http.client
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_BASE = "https://content-viewer-be.kaufda.de/v1"
# Bonn coordinates — pin the regional flyer editions (REWE prints several).
LAT, LNG, ZIP = "50.7327", "7.09631", "53115"
DISCOVERY_URLS = (
    f"https://www.kaufda.de/shelf?lat={LAT}&lng={LNG}&zip={ZIP}",
    "https://www.kaufda.de/Geschaefte/Aldi-Sued",
    "https://www.kaufda.de/Geschaefte/REWE",
    "https://www.kaufda.de/Geschaefte/Lidl",
)
# Retailer slug -> exact publisher name in kaufda's data.
RETAILERS = {
    "rewe": "REWE",
    "lidl": "Lidl",
    "aldi-sued": "ALDI SÜD",
}
MAX_BROCHURES_PER_RETAILER = 3  # regional editions of one week, not a catalog
MIN_OFFERS = 30  # a real weekly food flyer has hundreds; below this = broken
RETRY_SLEEPS = (30, 120, 300)
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
API_HEADERS = {
    "Accept": "application/json",
    "User-Agent": UA,
    "delivery_channel": "web",
    "user_platform_category": "desktop",
    "user_platform_os": "macos",
}

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data-kaufda"


def get(url, headers, timeout=60):
    # Running this locally from a sandboxed shell yields spurious
    # IncompleteRead aborts on the larger chunked pages (measured 1 of 3
    # succeeding, versus 6 of 6 unsandboxed and every time via curl). That is
    # the sandbox truncating, not the source — do not "fix" it here.
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def get_json(url):
    return json.loads(get(url, API_HEADERS))


def discover_brochures():
    """Collect (publisher, uuid, validFrom) from the SSR discovery pages."""
    found = {}

    def walk(node):
        if isinstance(node, dict):
            pub = node.get("publisher")
            cid = node.get("contentId") or node.get("id")
            if isinstance(pub, dict) and cid and node.get("validFrom"):
                found[cid] = {"publisher": pub.get("name"), "id": cid,
                              "validFrom": node["validFrom"]}
                return
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    for url in DISCOVERY_URLS:
        try:
            html = get(url, {"User-Agent": UA}).decode("utf-8", "replace")
        except (OSError, http.client.HTTPException) as err:
            print(f"WARN: discovery page failed ({url}): {err}")
            continue
        m = re.search(
            r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
            html, re.S)
        if not m:
            print(f"WARN: no __NEXT_DATA__ on {url}")
            continue
        walk(json.loads(m.group(1)))
    return list(found.values())


def week_monday(valid_from):
    """Monday of the week a brochure belongs to.

    validFrom is Sun 22:00/23:00 UTC (= Mon 00:00 local); +6h shifts it into
    the local Monday regardless of DST, then snap to that ISO week's Monday.
    """
    dt = datetime.fromisoformat(valid_from.replace("Z", "+00:00"))
    d = (dt + timedelta(hours=6)).date()
    return d - timedelta(days=d.weekday())


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


# Quantity/variety filler that carries no product identity. Kept deliberately
# short: "und"/"oder" were measured to collapse exactly one more offer, not
# worth the risk of merging two genuinely different ones.
DESC_FILLER = {"je", "ca", "versch", "sorten"}


def norm_desc(s):
    """Identity form of an offer description, for the id hash only.

    The same article printed in two regional editions gets its description
    paragraphs in a different order, with stray punctuation and a stray "je"
    ("je 8 x 25-g-Pckg." vs "8 x 25-g-Pckg.", "Hähnchen Art." vs "Hähnchen
    Art"). Hashing the raw text therefore mints two ids for one offer and the
    week's count comes out inflated — 74 of 467 REWE offers in KW32 2026.
    Dropping punctuation and filler and comparing the word SET instead of the
    word sequence collapses 89 such pairs across the KW31-KW33 snapshots
    without merging any two offers that disagree on more than a missing price.
    """
    s = unicodedata.normalize("NFKC", (s or "")).lower()
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(sorted(set(t for t in s.split() if t not in DESC_FILLER)))


def outranks(new, old):
    """Should `new` replace `old` when both normalize to the same id?

    Two regional editions of one offer can disagree twice over: a footnote row
    yields price=None where the other carries the price, and the same article
    is occasionally priced differently per region (REWE KW31 2026 printed one
    Lugana at 9.99 and 7.99). Picking whichever arrived first would make the
    snapshot depend on brochure order and churn between runs, so prefer a
    price over none and the lower of two prices — on an offers site the
    cheaper printed price is the useful one.
    """
    if old["price"] is None:
        return new["price"] is not None
    return new["price"] is not None and new["price"] < old["price"]


def normalize_offer(retailer, raw):
    """Flatten one Bonial offer into our record, minting the stable own id."""
    content = raw.get("content") or {}
    products = content.get("products") or []
    first = products[0] if products else {}
    names = [p.get("name") or "" for p in products]
    desc = " ".join(
        p.get("paragraph") or ""
        for prod in products
        for p in (prod.get("description") or [])
    ).strip()

    deals = content.get("deals") or []
    sales = next((d for d in deals if d.get("type") == "SALES_PRICE"), None)
    other = deals[0] if deals else {}
    price = sales.get("min") if sales else None
    price_max = sales.get("max") if sales else None
    gp_text = next(
        (d.get("priceByBaseUnit") for d in deals if d.get("priceByBaseUnit")),
        None,
    )

    images = first.get("images") or []
    image = (images[0].get("url") if images else None) or content.get("image")

    own_id = hashlib.sha1(
        "|".join([retailer, norm(first.get("brandName")),
                  norm(" / ".join(names)), norm_desc(desc)]).encode()
    ).hexdigest()[:12]

    page = ((content.get("parentContent") or {}).get("page") or {})
    return {
        "id": own_id,
        "kaufdaId": content.get("id"),
        "name": first.get("name"),
        "variants": names[1:],  # multi-product offers ("versch. Sorten")
        "brand": first.get("brandName"),
        "description": desc,
        "price": price if price not in (0, None) else None,
        "priceMax": price_max if price_max and price_max != price else None,
        "grundpreisText": gp_text,
        "dealType": (sales or other).get("type"),
        "dealText": (sales or other).get("description") or None,
        # FIXME: categoryPath is not a reliable taxonomy — the leaf is often a
        # brand ("Fischer", "Sun Garden") or plain wrong (an e-bike under
        # "Elektrowerkzeug", a hotel night under "Frühstück"), and 0-10 offers
        # per week have no path at all. Fine for tracing, not for grouping;
        # anything category-driven needs its own detector like build_indexes.py
        # has for EDEKA.
        "categoryPath": [c.get("name") for c in first.get("categoryPaths") or []],
        "image": image,
        "page": page.get("number"),
    }


def fetch_retailer(retailer, publisher, brochures, current_monday):
    """All offers of this retailer's current/upcoming week brochures, merged."""
    mine = [b for b in brochures
            if b["publisher"] == publisher
            and week_monday(b["validFrom"]) >= current_monday]
    mine.sort(key=lambda b: b["validFrom"])
    mine = mine[:MAX_BROCHURES_PER_RETAILER]
    if not mine:
        raise ValueError(f"no current brochure for {publisher} in discovery")

    by_week = {}
    for b in mine:
        monday = week_monday(b["validFrom"])
        meta = get_json(f"{API_BASE}/brochures/{b['id']}?lat={LAT}&lng={LNG}")
        pages = get_json(
            f"{API_BASE}/brochures/{b['id']}/pages?lat={LAT}&lng={LNG}")
        contents = pages.get("contents")
        if not isinstance(contents, list):
            raise ValueError(f"pages of {b['id']} has no contents list")
        week = by_week.setdefault(monday, {"brochures": [], "offers": {}})
        c = meta.get("content") or {}
        week["brochures"].append({
            "id": b["id"], "legacyId": c.get("legacyId"),
            "title": c.get("title"), "pageCount": c.get("pageCount"),
            "validFrom": c.get("validFrom"), "validUntil": c.get("validUntil"),
        })
        for pg in contents:
            for raw in pg.get("offers") or []:
                offer = normalize_offer(retailer, raw)
                prev = week["offers"].get(offer["id"])
                if prev is None or outranks(offer, prev):
                    week["offers"][offer["id"]] = offer
    return by_week


def normalized(offers):
    """Comparison form: volatile per-fetch fields dropped, sorted by id.

    kaufdaId/image/page can flip when regional editions merge in a different
    order; they say nothing about the actual offer content.
    """
    slim = [{k: v for k, v in o.items()
             if k not in ("kaufdaId", "image", "page")} for o in offers]
    slim.sort(key=lambda o: o["id"])
    return json.dumps(slim, sort_keys=True, ensure_ascii=False)


def load_offers(path):
    try:
        return json.loads(path.read_text())["offers"]
    except (OSError, ValueError, KeyError):
        return None


def write_week(retailer, monday, week, now, dry_run):
    offers = sorted(week["offers"].values(), key=lambda o: o["id"])
    if len(offers) < MIN_OFFERS:
        raise ValueError(f"only {len(offers)} offers for {retailer}")

    target = (DATA_DIR / retailer / str(monday.year)
              / f"KW{monday.isocalendar()[1]:02d}" / f"{monday.isoformat()}.json")
    rel = target.relative_to(REPO_ROOT)
    fetched_norm = normalized(offers)

    existing = load_offers(target)
    if existing is not None and len(offers) < len(existing):
        print(f"  {rel}: existing has {len(existing)} offers, fetched only "
              f"{len(offers)} — keeping the existing snapshot")
    elif existing is not None and normalized(existing) == fetched_norm:
        print(f"  {rel}: unchanged apart from volatile fields — keeping it")
    elif dry_run:
        print(f"  dry run: would write {len(offers)} offers to {rel}")
        return
    else:
        snapshot = {
            "source": "kaufda",
            "retailer": retailer,
            "fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "weekStart": monday.isoformat(),
            "brochures": week["brochures"],
            "offers": offers,
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")
        print(f"  wrote {len(offers)} offers to {rel}")


def main():
    parser = argparse.ArgumentParser(
        description="Fetch REWE/Lidl/ALDI SUED weekly offers via kaufda.")
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be written instead of writing")
    args = parser.parse_args()

    attempts = len(RETRY_SLEEPS) + 1
    brochures = []
    for attempt in range(1, attempts + 1):
        brochures = discover_brochures()
        if brochures:
            break
        print(f"discovery attempt {attempt}/{attempts} found nothing")
        if attempt <= len(RETRY_SLEEPS):
            time.sleep(RETRY_SLEEPS[attempt - 1])
    else:
        print("discovery failed — no brochures found on any page",
              file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    current_monday = now.date() - timedelta(days=now.date().weekday())
    failed = []
    for retailer, publisher in RETAILERS.items():
        print(f"{retailer}:")
        try:
            by_week = fetch_retailer(retailer, publisher, brochures,
                                     current_monday)
            for monday, week in sorted(by_week.items()):
                write_week(retailer, monday, week, now, args.dry_run)
        except (OSError, ValueError, http.client.HTTPException) as err:
            # One broken retailer must not lose the others' week; the next
            # cron run retries and audit_data.py flags a missing week.
            failed.append(retailer)
            print(f"  WARN: {retailer} failed: {err}")
    if len(failed) == len(RETAILERS):
        print("all retailers failed", file=sys.stderr)
        return 1
    if failed:
        print(f"partial success — failed: {', '.join(failed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
