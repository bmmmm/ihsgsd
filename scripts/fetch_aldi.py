#!/usr/bin/env python3
"""Fetch ALDI Sued weekly food offers into data-aldi/<year>/KW<ww>/<monday>.json.

Stdlib only, so the GitHub workflow stays thin and the same command runs
locally:

    python3 scripts/fetch_aldi.py [--dry-run]

The snapshot keeps the raw API product objects untouched (same philosophy as
the EDEKA snapshots under data/). data-aldi/ is deliberately a sibling of
data/, not a subdirectory: everything EDEKA-side (folder-structure.json,
build_indexes.py, audit_data.py) walks data/ and must never see these files.

Guards, mirroring the EDEKA workflow's lessons — they are what makes extra
cron runs free:
  - retry with backoff on network errors, malformed responses, partial lists
  - stale-week guard: the response carries no validFrom equivalent, so week
    identity is the Monday of the run's ISO week; if the fetched offers are
    identical to the previous week's snapshot, ALDI has not switched yet and
    nothing is written
  - never shrink an existing snapshot (a mid-switch fetch returns a partial
    list)
  - churn filter: skip the write when only volatile fields differ
"""

import argparse
import http.client
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_BASE = "https://api.aldi-sued.de/v3/product-search"
# Food "Wochenangebote" (Mo-Sa). Works without a servicePoint (B445 =
# Bonn-Nordstadt would pin a store, only relevant if regional differences ever
# matter). Non-food promotions use ?promotionKey=YYYY-MM-DD instead — a
# possible later addition, out of scope here.
CATEGORY_KEY = "1588161426582123"
PAGE_LIMIT = 60  # the API only accepts limits in {12,16,24,30,32,48,60}
MIN_OFFERS = 20  # fewer = mid-switch partial list, refuse to write
RETRY_SLEEPS = (30, 120, 300)
IMG_WIDTH = 320  # ~16 KB JPEG via the asset URL's {width} placeholder

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data-aldi"


def fetch_page(offset):
    params = urllib.parse.urlencode(
        {
            "currency": "EUR",
            "serviceType": "walk-in",
            "categoryKey": CATEGORY_KEY,
            "limit": PAGE_LIMIT,
            "offset": offset,
            "sort": "relevance",
        }
    )
    req = urllib.request.Request(
        f"{API_BASE}?{params}", headers={"Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def fetch_all_offers():
    """Merge all pages; raise on any malformed page."""
    offers = []
    offset = 0
    total = None
    while total is None or offset < total:
        page = fetch_page(offset)
        data = page.get("data")
        if not isinstance(data, list):
            raise ValueError(f"response 'data' is not a list at offset {offset}")
        if total is None:
            total = page.get("meta", {}).get("pagination", {}).get("totalCount")
            if not isinstance(total, int):
                raise ValueError("no meta.pagination.totalCount in response")
        if not data:
            break  # defensive: never loop forever on an empty page
        offers.extend(data)
        offset += PAGE_LIMIT
    # The relevance sort can shift items between pages mid-pagination, so the
    # merge may contain duplicates; keep the first occurrence per sku.
    seen = set()
    unique = []
    for offer in offers:
        sku = offer.get("sku")
        if sku is not None:
            if sku in seen:
                continue
            seen.add(sku)
        unique.append(offer)
    unique.sort(key=lambda o: str(o.get("sku")))
    return unique, total


def normalized(offers):
    """Comparison form: assets dropped, offers sorted by sku, keys sorted.

    Whether ALDI mints per-request asset URLs like EDEKA does is unknown —
    dropping assets from the comparison is cheap insurance either way.
    """
    slim = [{k: v for k, v in o.items() if k != "assets"} for o in offers]
    slim.sort(key=lambda o: str(o.get("sku")))
    return json.dumps(slim, sort_keys=True, ensure_ascii=False)


def snapshot_path(monday):
    # Calendar year of the Monday, matching data/'s convention: the folder year
    # always equals the filename's own year, even across the Dec/Jan ISO
    # week-numbering boundary.
    return (
        DATA_DIR
        / str(monday.year)
        / f"KW{monday.isocalendar()[1]:02d}"
        / f"{monday.isoformat()}.json"
    )


def load_offers(path):
    try:
        return json.loads(path.read_text())["offers"]
    except (OSError, ValueError, KeyError):
        return None


def archive_images(offers, img_dir):
    """Archive one IMG_WIDTH thumbnail per offer, keyed by sku.

    Mirrors the EDEKA workflow's image step: skip already-present files,
    failures are non-fatal. Whether ALDI purges old asset URLs the way EDEKA
    purged images is unknown — archiving from week 1 is the lesson from the
    75 EDEKA weeks that are gone for good.
    """
    img_dir.mkdir(parents=True, exist_ok=True)
    ok = fail = 0
    for offer in offers:
        sku = offer.get("sku")
        assets = offer.get("assets") or []
        url = assets[0].get("url") if assets else None
        if not sku or not url:
            continue
        out = img_dir / f"{sku}.jpg"
        if out.exists():
            continue
        url = url.replace("{width}", str(IMG_WIDTH)).replace(
            "{slug}", offer.get("urlSlugText") or "product"
        )
        try:
            req = urllib.request.Request(url, headers={"Accept": "image/*"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            out.write_bytes(data)
            ok += 1
        except (OSError, http.client.HTTPException) as err:
            out.unlink(missing_ok=True)
            fail += 1
            print(f"WARN: could not fetch image for {sku} ({err})")
        time.sleep(0.1)  # gentle throttle for the image host
    if ok or fail:
        print(
            f"archived {ok} image(s), {fail} failure(s) into "
            f"{img_dir.relative_to(REPO_ROOT)}"
        )


def main():
    parser = argparse.ArgumentParser(
        description="Fetch this week's ALDI Sued food offers into data-aldi/."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be written instead of writing it",
    )
    args = parser.parse_args()

    attempts = len(RETRY_SLEEPS) + 1
    last_err = None
    for attempt in range(1, attempts + 1):
        try:
            offers, total = fetch_all_offers()
            if len(offers) < MIN_OFFERS:
                raise ValueError(
                    f"only {len(offers)} offers (mid-switch partial list?)"
                )
            break
        except (OSError, ValueError, http.client.HTTPException) as err:
            last_err = err
            print(f"fetch attempt {attempt}/{attempts} failed: {err}")
            if attempt <= len(RETRY_SLEEPS):
                sleep = RETRY_SLEEPS[attempt - 1]
                print(f"retrying in {sleep}s...")
                time.sleep(sleep)
    else:
        print(f"giving up after {attempts} attempts: {last_err}", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    monday = now.date() - timedelta(days=now.date().weekday())
    target = snapshot_path(monday)
    fetched_norm = normalized(offers)

    # Stale-week guard: an early Monday run must not file last week's offers
    # under the new Monday.
    prev_path = snapshot_path(monday - timedelta(days=7))
    prev_offers = load_offers(prev_path)
    if prev_offers is not None and normalized(prev_offers) == fetched_norm:
        print(
            f"offers are identical to last week's snapshot "
            f"({prev_path.relative_to(REPO_ROOT)}) — ALDI has not switched "
            f"yet, nothing written"
        )
        return 0

    existing = load_offers(target)
    if existing is not None and len(offers) < len(existing):
        print(
            f"existing {target.relative_to(REPO_ROOT)} has "
            f"{len(existing)} offers, fetched only {len(offers)} — "
            f"keeping the existing snapshot"
        )
    elif existing is not None and normalized(existing) == fetched_norm:
        print(
            f"{target.relative_to(REPO_ROOT)} is unchanged apart from "
            f"volatile fields — keeping it"
        )
    elif args.dry_run:
        print(
            f"dry run: would write {len(offers)} offers (totalCount {total}) "
            f"to {target.relative_to(REPO_ROOT)}"
        )
        return 0
    else:
        snapshot = {
            "source": "aldi-sued",
            "fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "weekStart": monday.isoformat(),
            "totalCount": total,
            "offers": offers,
        }
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"
        )
        print(
            f"wrote {len(offers)} offers (totalCount {total}) to "
            f"{target.relative_to(REPO_ROOT)}"
        )

    if args.dry_run:
        return 0
    # Also runs when the snapshot was kept, so images that failed on an
    # earlier run get retried. The freshly fetched URLs are used (not the
    # stored ones) in case ALDI mints them per request.
    archive_images(offers, target.parent / "img")
    return 0


if __name__ == "__main__":
    sys.exit(main())
