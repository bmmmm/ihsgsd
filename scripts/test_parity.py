#!/usr/bin/env python3
"""Prove that the JS and Python copies of the shared logic still agree.

Three pieces of logic exist twice — once in `prospekt.js` for the browser, once
in Python for the index builder and the generators:

    Grundpreis parsing/derivation   prospekt.js  <->  build_indexes.py
    the product identity key        prospekt.js  <->  build_indexes.py
    the diet detectors              prospekt.js  <->  generate_prospekt.py

Divergence is silent and expensive. A product key that differs by one character
yields zero history lookups, so badges just stop appearing — no error anywhere.
And a detector that drifts changes what the reader is shown: the topic sections
kept an unbounded /spezi/ long after the chip logic had moved on, which scored
"Fischspezialitäten" as a Spezi favourite and shielded it from the fish filter.

So this compares the two implementations over EVERY offer in data/ rather than
over a handful of fixtures — the real corpus is what surfaced the ASCII-\\b bug
("Rumänien" matching /\\brum\\b/) in the first place.

The JS side is loaded whole via `new Function`, not pulled out with string
slicing: a test that re-implements or excerpts the code under test can pass
while the shipped file is broken. prospekt.js guards its own bootstrap with
`typeof document !== 'undefined'`, so loading it under Node defines the
functions without touching the DOM.

Usage:
    python3 scripts/test_parity.py           # all weeks (~15k offers)
    python3 scripts/test_parity.py --quick   # newest week only

--quick is a smoke test, NOT a verification. Verified by deleting "bockwurst"
from the JS meat detector: the full run caught it (14 mismatches, named), while
--quick passed happily because the newest week has no Bockwurst offer. Detector
drift only shows up against the whole corpus — trust a green --quick for "did I
break everything", never for "are the two copies still equal".

Exit code 0 = the implementations agree, 1 = they have drifted.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import build_indexes as bx          # noqa: E402
import generate_prospekt as gp      # noqa: E402

# Everything the JS side must expose, evaluated inside prospekt.js's own scope.
JS_HARNESS = r"""
const fs = require('fs');
// argv[0]=node, argv[1]=this harness — the real arguments start at 2.
const [, , grundpreisPath, prospektPath, offersPath] = process.argv;
// Both files in one scope, in the same order the pages load them: grundpreis.js
// defines the Grundpreis logic, prospekt.js the diet detectors on top of it.
const src = fs.readFileSync(grundpreisPath, 'utf8') + '\n' + fs.readFileSync(prospektPath, 'utf8');
const api = new Function(src + `
    ; return { resolveGp, productKey, looksMeat, looksFish, looksSpirits, looksVegan, TOPICS };
`)();
// The whole veto question, not just the title detector: a diet topic fires on
// its CATEGORY as well, and that half used to skip the vegan exemption on the
// JS side only — the page hid vegan sausages filed under "Fleisch & Wurst"
// while the generator recommended them. Comparing the detectors alone missed
// it for as long as it existed.
const meatTopic = api.TOPICS.find(t => t.key === 'fleisch');
const fishTopic = api.TOPICS.find(t => t.key === 'fisch');
// The positive topics the flyer generator builds its sections from. These
// drifted silently for as long as they existed in two places: the generator
// missed Weißbier and counted Gebäckspezialitäten as Spezi, so the flyer and
// the page disagreed about the same offer.
const bierTopic = api.TOPICS.find(t => t.key === 'bier');
const speziTopic = api.TOPICS.find(t => t.key === 'spezi');
const veganTopic = api.TOPICS.find(t => t.key === 'vegan');
const offers = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
const out = offers.map(o => {
    const gp = api.resolveGp(o);
    return {
        gp: gp.val,
        unit: gp.unit,
        derived: gp.derived,
        key: gp.val === null ? null : api.productKey(o, gp.unit),
        meat: api.looksMeat(o),
        fish: api.looksFish(o),
        spirits: api.looksSpirits(o),
        vegan: api.looksVegan(o),
        vetoMeat: meatTopic.test(o),
        vetoFish: fishTopic.test(o),
        bier: bierTopic.test(o),
        spezi: speziTopic.test(o),
        veganTopic: veganTopic.test(o),
    };
});
process.stdout.write(JSON.stringify(out));
"""


def py_side(offer):
    """The Python verdict for one offer, shaped like the JS one."""
    val, unit, flag = bx.resolve_gp(offer)
    title = offer.get("title") or ""
    return {
        "gp": val,
        "unit": unit,
        "derived": flag == "derived",
        "key": None if val is None else bx.product_key(offer, unit),
        # generate_prospekt applies the vegan exemption inside diet_excluded();
        # mirror that split here so both sides mean the same thing. The
        # exemption reads title+description, the meat/fish detectors title only.
        "meat": bool(gp.MEAT_RE.search(title)) and not gp.looks_vegan(offer),
        "fish": bool(gp.FISH_RE.search(title)) and not gp.looks_vegan(offer),
        "spirits": bool(gp.SPIRITS_RE.search(title)),
        "vegan": gp.looks_vegan(offer),
        # The composite rule, category included — see the JS harness above.
        "vetoMeat": gp.diet_excluded(offer, {"fleisch"}),
        "vetoFish": gp.diet_excluded(offer, {"fisch"}),
        # The section topics — see the JS harness above.
        "bier": gp.topic_bier(offer),
        "spezi": gp.topic_spezi(offer),
        "veganTopic": gp.topic_vegan(offer),
    }


def load_offers(quick):
    files = sorted(glob.glob(str(REPO_ROOT / "data" / ("[0-9]" * 4) / "KW*" / "*.json")))
    if not files:
        sys.exit("No data files found — run from a checkout with data/ present.")
    if quick:
        files = files[-1:]
    offers = []
    for path in files:
        with open(path, encoding="utf-8") as fh:
            offers.extend(json.load(fh).get("offers", []))
    return files, offers


def run_js(offers):
    """Run the JS side once over all offers; returns its verdicts."""
    tmp = REPO_ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    offers_path = tmp / "parity-offers.json"
    harness_path = tmp / "parity-harness.js"
    offers_path.write_text(json.dumps(offers, ensure_ascii=False), encoding="utf-8")
    harness_path.write_text(JS_HARNESS, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["node", str(harness_path), str(REPO_ROOT / "grundpreis.js"),
             str(REPO_ROOT / "prospekt.js"), str(offers_path)],
            capture_output=True, text=True, cwd=str(REPO_ROOT),
        )
    except FileNotFoundError:
        sys.exit("node not found — install Node to run the parity test.")
    finally:
        offers_path.unlink(missing_ok=True)
        harness_path.unlink(missing_ok=True)
    if proc.returncode != 0:
        sys.exit(f"JS harness failed:\n{proc.stderr.strip()[-2000:]}")
    return json.loads(proc.stdout)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="newest week only")
    ap.add_argument("--max-report", type=int, default=15,
                    help="how many mismatches to print per field (default 15)")
    args = ap.parse_args()

    files, offers = load_offers(args.quick)
    print(f"Comparing {len(offers)} offer(s) from {len(files)} week file(s) …")

    js = run_js(offers)
    if len(js) != len(offers):
        sys.exit(f"JS returned {len(js)} verdicts for {len(offers)} offers")

    # Adding a key to py_side() and the JS harness is not enough — a field only
    # becomes a gate once it is named here.
    fields = ("gp", "unit", "derived", "key", "meat", "fish", "spirits", "vegan",
              "vetoMeat", "vetoFish", "bier", "spezi", "veganTopic")
    mismatches = {f: [] for f in fields}
    for offer, j in zip(offers, js):
        p = py_side(offer)
        for f in fields:
            # Grundpreis is a rounded float on both sides; compare with a
            # tolerance so a float-repr difference is not reported as drift.
            if f == "gp" and isinstance(p[f], float) and isinstance(j[f], (int, float)):
                if abs(p[f] - j[f]) < 0.005:
                    continue
            if p[f] != j[f]:
                mismatches[f].append((offer.get("title", ""), offer.get("baseUnit", ""), p[f], j[f]))

    total = sum(len(v) for v in mismatches.values())
    for f in fields:
        hits = mismatches[f]
        status = "ok" if not hits else f"{len(hits)} MISMATCH(ES)"
        print(f"  {f:<8} {status}")
        for title, base_unit, pv, jv in hits[:args.max_report]:
            print(f"      {title[:52]!r} baseUnit={base_unit[:32]!r}")
            print(f"        python={pv!r}  js={jv!r}")
        if len(hits) > args.max_report:
            print(f"      … and {len(hits) - args.max_report} more")

    if total:
        print(f"\nFAIL: {total} mismatch(es) — the JS and Python copies have drifted.")
        return 1
    print(f"\nPASS: JS and Python agree on all {len(offers)} offers.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
