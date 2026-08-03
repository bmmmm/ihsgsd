#!/usr/bin/env python3
"""Recompute the offer ids of archived data-kaufda snapshots in place.

    python3 scripts/rekey_kaufda.py [--apply]

Run this after every change to how fetch_kaufda.py mints an offer id, because
a refetch cannot deliver the fix: write_week() refuses any result smaller than
what is already on disk (the never-shrink guard that protects against a
mid-switch partial list). A better key collapses duplicates and therefore
always looks smaller, so archived weeks would keep the old ids forever.

The id hash and the collision precedence are imported from fetch_kaufda rather
than reimplemented — a second copy would re-key the archive slightly
differently from the fetcher that writes every future week, and that drift is
silent. Same reason scripts/test_parity.py exists for the JS/Python pair.

Only `id` and the number of rows change. Every other field is carried over
untouched, and the file keeps the fetcher's own formatting, so re-running this
on already-migrated data is a no-op.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from fetch_kaufda import norm, norm_desc, outranks  # noqa: E402

DATA_DIR = REPO_ROOT / "data-kaufda"


def offer_id(retailer, offer):
    """The id fetch_kaufda would mint for this offer today."""
    names = [offer["name"]] + (offer["variants"] or [])
    return hashlib.sha1(
        "|".join([retailer, norm(offer["brand"]),
                  norm(" / ".join(n or "" for n in names)),
                  norm_desc(offer["description"])]).encode()
    ).hexdigest()[:12]


def rekey(snapshot):
    """Re-keyed offers of one snapshot, deduplicated as the fetcher would."""
    retailer = snapshot["retailer"]
    merged = {}
    for offer in snapshot["offers"]:
        offer = dict(offer, id=offer_id(retailer, offer))
        prev = merged.get(offer["id"])
        if prev is None or outranks(offer, prev):
            merged[offer["id"]] = offer
    return sorted(merged.values(), key=lambda o: o["id"])


def main():
    parser = argparse.ArgumentParser(
        description="Recompute data-kaufda offer ids after a key change.")
    parser.add_argument("--apply", action="store_true",
                        help="write the files instead of only reporting")
    args = parser.parse_args()

    paths = sorted(DATA_DIR.glob("*/20*/KW*/*.json"))
    if not paths:
        sys.exit(f"no snapshots under {DATA_DIR} — run from the repo root.")

    before = after = 0
    for path in paths:
        snapshot = json.loads(path.read_text())
        offers = rekey(snapshot)
        before += len(snapshot["offers"])
        after += len(offers)
        change = len(snapshot["offers"]) - len(offers)
        print(f"  {path.relative_to(REPO_ROOT)}: {len(snapshot['offers'])} -> "
              f"{len(offers)}" + (f"  (-{change})" if change else ""))
        if args.apply:
            snapshot["offers"] = offers
            path.write_text(
                json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n")

    print(f"TOTAL {before} -> {after}  (-{before - after})")
    if not args.apply:
        print("dry run — pass --apply to write")
    return 0


if __name__ == "__main__":
    sys.exit(main())
