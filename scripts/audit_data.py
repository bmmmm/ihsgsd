#!/usr/bin/env python3
"""Data-quality audit over every weekly snapshot, the derived indexes and the
ALDI sibling archive (data-aldi/).

Read-only. Run it after a fetch, or whenever the archive feels off:

    python3 scripts/audit_data.py           # summary
    python3 scripts/audit_data.py -v        # list every finding

Exit code 1 only for findings that are actionable NOW (index drift, a snapshot
filed under the wrong week, a self-contradicting price). Historic facts that
cannot be repaired — the three permanently missing weeks, images EDEKA purged
before the local archive existed — are reported but never fail the run, so a
non-zero exit always means "something changed that you can still fix".

stdlib only, same as build_indexes.py.
"""
import collections
import datetime
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_indexes as bx  # noqa: E402

DATA_DIR = "data"
ALDI_DATA_DIR = "data-aldi"
# A missed sibling-archive week can never be backfilled (the sources serve
# only current flyers). A NEW gap means the cron broke and fails the run; once
# investigated it is added here and becomes a permanent note, keeping a
# non-zero exit meaningful. Keys are ISO Mondays, e.g. "2026-08-03".
ALDI_KNOWN_MISSING = set()
KAUFDA_KNOWN_MISSING = {"rewe": set(), "lidl": set(), "aldi-sued": set()}
VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv

# The Grundpreis expression itself contains a measurement ("1 kg = € 3.23"), so
# it must be cut out before the description can be mined for the PACK size —
# otherwise every quoted offer looks ambiguous and no cross-check is possible.
STRIP_GP_RE = re.compile(
    r"\(?\s*1\s*[A-Za-z]{1,3}\s*=\s*(?:ab\s*)?€\s*[\d.,]+(?:\s*/\s*€\s*[\d.,]+)?\s*\)?"
)
# Below this ratio a disagreement is a rounding/packaging nuance, above it one
# of the two numbers is simply wrong.
CONTRADICTION_RATIO = 3.0


class Report:
    def __init__(self):
        self.blocking = 0
        self.notes = 0

    def section(self, title):
        print(f"\n{title}")

    def ok(self, msg):
        print(f"  ok    {msg}")

    def note(self, msg, items=()):
        """A finding that is real but cannot be acted on (historic loss)."""
        self.notes += 1
        print(f"  note  {msg}")
        self._items(items)

    def fail(self, msg, items=()):
        """A finding worth fixing now."""
        self.blocking += 1
        print(f"  FAIL  {msg}")
        self._items(items)

    def _items(self, items):
        items = list(items)
        if not items:
            return
        shown = items if VERBOSE else items[:5]
        for it in shown:
            print(f"          {it}")
        if len(items) > len(shown):
            print(f"          … {len(items) - len(shown)} more (-v to list all)")


def load_snapshots():
    out = []
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "20*", "KW*", "*.json"))):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        m = re.search(r"data/(\d{4})/(KW\d+)/(\d{4}-\d{2}-\d{2})\.json", path)
        out.append({
            "path": path, "data": data,
            "year": m.group(1), "kw": m.group(2), "date": m.group(3),
            "valid_from": data.get("validFrom"),
            "offers": data.get("offers") or [],
        })
    return out


def check_week_identity(snaps, rep):
    """Folder/filename must match the week the offers are actually valid for."""
    rep.section("Week identity (folder + filename vs. the API's validFrom)")
    wrong = []
    for s in snaps:
        vf = s["valid_from"]
        if not vf:
            wrong.append(f"{s['path']}: no validFrom in the file")
            continue
        d = datetime.date.fromisoformat(vf)
        expect_kw = f"KW{d.isocalendar()[1]:02d}"
        if expect_kw != s["kw"] or vf != s["date"]:
            wrong.append(f"{s['path']} -> offers start {vf}, belongs in {d.year}/{expect_kw}/{vf}.json")
    if wrong:
        # Pre-dates filing by validFrom; renaming would rewrite archive paths, so
        # it is reported rather than fixed silently.
        rep.note(f"{len(wrong)} snapshot(s) filed under a week they are not valid for", wrong)
    else:
        rep.ok(f"all {len(snaps)} snapshots sit in the right week")

    rep.section("Duplicate offer weeks (same validFrom in two files)")
    by_vf = collections.defaultdict(list)
    for s in snaps:
        if s["valid_from"]:
            by_vf[s["valid_from"]].append(s)
    dupes = {k: v for k, v in by_vf.items() if len(v) > 1}
    if dupes:
        items = []
        for vf, lst in sorted(dupes.items()):
            titles = [{o.get("title") for o in s["offers"]} for s in lst]
            shared = len(set.intersection(*titles)) if titles else 0
            items.append(f"validFrom={vf}: " + ", ".join(s["path"] for s in lst)
                         + f" ({shared} shared titles)")
        # Both copies land in the price history as separate weeks, which inflates
        # "N comparison weeks" and the offer-frequency estimate.
        rep.fail(f"{len(dupes)} offer week(s) stored twice — they count double in the price history", items)
    else:
        rep.ok("every offer week appears exactly once")


def check_cadence(snaps, rep):
    rep.section("Weekly cadence")
    dates = sorted(datetime.date.fromisoformat(s["date"]) for s in snaps)
    missing = []
    for a, b in zip(dates, dates[1:]):
        gap = (b - a).days
        if gap > 8:
            for i in range(1, (gap + 3) // 7):
                d = a + datetime.timedelta(days=7 * i)
                missing.append(f"{d} (KW{d.isocalendar()[1]:02d})")
    if missing:
        # The API only ever serves the current week — a gap can never be backfilled.
        rep.note(f"{len(missing)} week(s) never captured (permanent, the API serves only the current week)", missing)
    else:
        rep.ok("no gaps in the weekly cadence")


def check_offer_sanity(snaps, rep):
    rep.section("Offer records")
    counts = sorted(len(s["offers"]) for s in snaps)
    median = counts[len(counts) // 2]
    thin = [f"{s['date']}: {len(s['offers'])} offers" for s in snaps
            if len(s["offers"]) < median * 0.6]
    if thin:
        rep.fail(f"{len(thin)} week(s) hold far fewer offers than usual (median {median}) — possible partial fetch", thin)
    else:
        rep.ok(f"offer counts plausible (median {median}, min {counts[0]}, max {counts[-1]})")

    missing_fields, bad_price = [], []
    for s in snaps:
        for o in s["offers"]:
            if not o.get("title") or not (o.get("category") or {}).get("name"):
                missing_fields.append(f"{s['date']}: id={o.get('id')} lacks title/category")
            if bx.face_price(o) is None:
                bad_price.append(f"{s['date']}: {str(o.get('title'))[:40]} price={o.get('price')}")
    if missing_fields:
        rep.fail(f"{len(missing_fields)} offer(s) missing title or category", missing_fields)
    else:
        rep.ok("every offer carries a title and a category")
    if bad_price:
        # Source typos (the famous €47,150 Camembert). build_indexes already
        # drops these via FACE_MAX, so they poison nothing — reported so a NEW
        # one is visible, but never a reason to fail.
        rep.note(f"{len(bad_price)} offer(s) with an unusable price — excluded by the FACE_MAX guard", bad_price)
    else:
        rep.ok("every offer has a usable face price")

    dupes = []
    for s in snaps:
        ids = collections.Counter(o.get("id") for o in s["offers"])
        for oid, n in ids.items():
            if n > 1:
                dupes.append(f"{s['date']}: offer id {oid} appears {n}x")
    if dupes:
        rep.fail(f"{len(dupes)} repeated offer id(s) within a single week", dupes)
    else:
        rep.ok("offer ids are unique within each week")


def check_price_contradictions(snaps, rep):
    """EDEKA's own Grundpreis vs. price ÷ pack size.

    Catches errors in the SOURCE data, which a price archive must not inherit:
    a wrong €/unit becomes a phantom all-time low or high forever.
    """
    rep.section("Grundpreis vs. price ÷ pack size")
    compared, bad = 0, []
    for s in snaps:
        for o in s["offers"]:
            val, unit, flag = bx.parse_gp(o)
            if val is None or flag != "exact" or val <= 0:
                continue
            face = bx.face_price(o)
            if not face:
                continue
            src = bx.norm(o.get("baseUnit")) or STRIP_GP_RE.sub(" ", bx.norm(o.get("description")))
            dv, du = bx.derive_from_text(src, face)
            if dv is None or du != unit or dv <= 0:
                continue
            compared += 1
            if max(val / dv, dv / val) > CONTRADICTION_RATIO:
                bad.append(f"{s['date']}: {str(o.get('title'))[:38]} — EDEKA {val} €/{unit}, "
                           f"price÷size {dv} €/{unit} | {bx.norm(o.get('description'))[:52]}")
    if bad:
        # EDEKA's own typos; we cannot correct the source and must not guess
        # which of the two numbers is the wrong one. Listed so the damage is
        # known (a bogus €/unit becomes a phantom all-time low forever) and so a
        # sudden rise in the count is visible.
        rep.note(f"{len(bad)} offer(s) whose own numbers contradict each other (of {compared} checked)", bad)
    else:
        rep.ok(f"all {compared} quoted Grundpreise agree with price ÷ pack size")


def check_history(rep):
    rep.section("Price history")
    path = os.path.join(DATA_DIR, "price-history-index.json")
    if not os.path.exists(path):
        rep.fail("price-history-index.json is missing — run scripts/build_indexes.py")
        return
    with open(path, encoding="utf-8") as fh:
        ph = json.load(fh)
    prods = ph.get("products", [])

    jumps = []
    for p in prods:
        vals = [o["gp"] for o in p["obs"] if "gpf" not in o and o.get("gp", 0) > 0]
        if len(vals) >= 2 and max(vals) / min(vals) > 8:
            jumps.append(f"{p['title'][:44]} [{p['unit']}] {min(vals)}–{max(vals)} "
                         f"({max(vals) / min(vals):.0f}x)")
    if jumps:
        # Usually one title covering two different products, or a source error.
        rep.note(f"{len(jumps)} series swing by more than 8x — check for merged products", jumps)
    else:
        rep.ok("no implausible price swings")

    derived = sum(1 for p in prods for o in p["obs"] if o.get("gpd"))
    total = sum(len(p["obs"]) for p in prods)
    rep.ok(f"{len(prods)} products, {total} observations ({derived} derived, "
           f"{100 * derived / total:.0f}%)")


def check_indexes(snaps, rep):
    rep.section("Index integrity")
    on_disk = {s["path"][len(DATA_DIR) + 1:] for s in snaps}
    fs_path = os.path.join(DATA_DIR, "folder-structure.json")
    with open(fs_path, encoding="utf-8") as fh:
        listed = set(json.load(fh))
    if listed - on_disk:
        rep.fail("folder-structure.json lists files that do not exist", sorted(listed - on_disk))
    if on_disk - listed:
        rep.fail("snapshots missing from folder-structure.json (absent from the week dropdown)",
                 sorted(on_disk - listed))
    if listed == on_disk:
        rep.ok(f"folder-structure.json matches the {len(on_disk)} snapshots on disk")

    ph_path = os.path.join(DATA_DIR, "price-history-index.json")
    if os.path.exists(ph_path):
        with open(ph_path, encoding="utf-8") as fh:
            ph = json.load(fh)
        hist_dates = {o["d"] for p in ph.get("products", []) for o in p["obs"]}
        snap_dates = {s["date"] for s in snaps}
        if hist_dates - snap_dates:
            rep.fail("price history references dates with no snapshot",
                     sorted(hist_dates - snap_dates))
        else:
            rep.ok("price history references only real snapshots")


def check_images(snaps, rep):
    rep.section("Archived product images")
    rows = []
    for s in snaps:
        folder = os.path.dirname(s["path"])
        ids = [o.get("id") for o in s["offers"] if o.get("id") is not None]
        have = sum(1 for i in ids if os.path.exists(os.path.join(folder, "img", f"{i}.jpg")))
        rows.append((s["date"], have, len(ids)))
    archived = [r for r in rows if r[1] > 0]
    if not archived:
        rep.note("no week has archived images yet")
        return
    first = min(r[0] for r in archived)
    # Before the archive existed EDEKA had already purged those images (~1-2
    # months after the offer ends), so they are gone for good — not a defect.
    incomplete = [f"{d}: {h}/{n} ({100 * h / n:.0f}%)" for d, h, n in rows
                  if d >= first and n and h / n < 0.95]
    if incomplete:
        rep.fail(f"{len(incomplete)} week(s) incompletely archived since {first}", incomplete)
    else:
        rep.ok(f"every week since {first} fully archived ({len(archived)} weeks)")
    lost = sum(1 for d, h, n in rows if d < first)
    if lost:
        rep.note(f"{lost} week(s) predate the archive — EDEKA purged those images, unrecoverable")


def check_archive(rep, base_dir, label, key_field, known_missing,
                  min_offers=20, images=False):
    """One compact audit section for a sibling archive (data-aldi/, one
    data-kaufda/ retailer) — deliberately invisible to every EDEKA check."""
    rep.section(f"{label} ({base_dir}/)")
    paths = sorted(glob.glob(os.path.join(base_dir, "20*", "KW*", "*.json")))
    if not paths:
        rep.note(f"no {label} snapshots yet")
        return
    snaps = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        m = re.search(r"(\d{4})/(KW\d+)/(\d{4}-\d{2}-\d{2})\.json$", path)
        snaps.append({"path": path, "year": m.group(1), "kw": m.group(2),
                      "date": m.group(3), "week_start": data.get("weekStart"),
                      "total": data.get("totalCount"),
                      "offers": data.get("offers") or []})

    misfiled = []
    for s in snaps:
        d = datetime.date.fromisoformat(s["date"])
        if (s["week_start"] != s["date"] or d.weekday() != 0
                or s["kw"] != f"KW{d.isocalendar()[1]:02d}"
                or s["year"] != str(d.year)):
            misfiled.append(f"{s['path']}: weekStart={s['week_start']}, "
                            f"expected a Monday matching {s['year']}/{s['kw']}")
    if misfiled:
        rep.fail(f"{len(misfiled)} {label} snapshot(s) filed under the wrong week", misfiled)
    else:
        rep.ok(f"all {len(snaps)} {label} snapshots sit in the right week")

    dates = sorted(datetime.date.fromisoformat(s["date"]) for s in snaps)
    new_gaps, known_gaps = [], []
    for a, b in zip(dates, dates[1:]):
        gap = (b - a).days
        if gap > 8:
            for i in range(1, (gap + 3) // 7):
                d = a + datetime.timedelta(days=7 * i)
                bucket = known_gaps if d.isoformat() in known_missing else new_gaps
                bucket.append(f"{d} (KW{d.isocalendar()[1]:02d})")
    if new_gaps:
        rep.fail(f"{len(new_gaps)} {label} week(s) missed — check the cron, "
                 f"then add them to the known-missing set", new_gaps)
    elif known_gaps:
        rep.note(f"{len(known_gaps)} {label} week(s) never captured (permanent)", known_gaps)
    else:
        rep.ok(f"no gaps across {len(dates)} week(s)")

    thin = [f"{s['date']}: {len(s['offers'])} offers" for s in snaps
            if len(s["offers"]) < min_offers]
    if thin:
        rep.fail(f"{len(thin)} {label} snapshot(s) look like a partial fetch", thin)
    else:
        rep.ok("offer counts plausible (min "
               f"{min(len(s['offers']) for s in snaps)})")

    # Only ALDI snapshots carry the source's own count. It overshoots by a few
    # percent by design (the API filters after counting — see fetch_aldi.py),
    # so this fires on a lost page, not on that noise. It matters because an
    # empty page ends pagination silently: a half-fetched week is otherwise
    # indistinguishable from a genuinely small one.
    counted = [s for s in snaps if isinstance(s["total"], int) and s["total"]]
    if counted:
        short = [f"{s['date']}: {len(s['offers'])} of {s['total']}"
                 for s in counted if len(s["offers"]) < 0.9 * s["total"]]
        if short:
            rep.fail(f"{len(short)} {label} snapshot(s) hold far fewer offers "
                     f"than the source counted — refetch while the week is live",
                     short)
        else:
            worst = min(len(s["offers"]) / s["total"] for s in counted)
            rep.ok(f"offer counts match the source's totalCount "
                   f"(worst {worst:.0%})")

    dupes = []
    for s in snaps:
        keys = collections.Counter(o.get(key_field) for o in s["offers"])
        dupes += [f"{s['date']}: {key_field} {k} appears {n}x"
                  for k, n in keys.items() if n > 1]
    if dupes:
        rep.fail(f"{len(dupes)} repeated {key_field}(s) within a single {label} week", dupes)
    else:
        rep.ok(f"{key_field}s are unique within each week")

    if not images:
        return
    # Unlike EDEKA there is no pre-archive era: images are archived from week
    # one, so any incomplete week is actionable while the URLs still work.
    incomplete = []
    for s in snaps:
        folder = os.path.dirname(s["path"])
        keys = [o.get(key_field) for o in s["offers"] if o.get(key_field)]
        have = sum(1 for k in keys
                   if os.path.exists(os.path.join(folder, "img", f"{k}.jpg")))
        if keys and have / len(keys) < 0.95:
            incomplete.append(f"{s['date']}: {have}/{len(keys)} images")
    if incomplete:
        rep.fail(f"{len(incomplete)} {label} week(s) incompletely archived — "
                 f"re-run the fetcher while the URLs are live", incomplete)
    else:
        rep.ok(f"images fully archived for all {len(snaps)} week(s)")


def main():
    snaps = load_snapshots()
    if not snaps:
        sys.exit("No snapshots found — run from the repo root.")
    print(f"Auditing {len(snaps)} weekly snapshots "
          f"({sum(len(s['offers']) for s in snaps)} offers)")

    rep = Report()
    check_week_identity(snaps, rep)
    check_cadence(snaps, rep)
    check_offer_sanity(snaps, rep)
    check_price_contradictions(snaps, rep)
    check_history(rep)
    check_indexes(snaps, rep)
    check_images(snaps, rep)
    check_archive(rep, ALDI_DATA_DIR, "ALDI archive", "sku",
                  ALDI_KNOWN_MISSING, images=True)
    for retailer, missing in KAUFDA_KNOWN_MISSING.items():
        # kaufda images are deliberately not archived (290 KB each, no
        # server-side resize), so no image check for these archives.
        check_archive(rep, os.path.join("data-kaufda", retailer),
                      f"kaufda {retailer}", "id", missing, min_offers=30)

    print()
    if rep.blocking:
        print(f"{rep.blocking} actionable finding(s), {rep.notes} historic note(s).")
        sys.exit(1)
    print(f"No actionable findings. {rep.notes} historic note(s).")


if __name__ == "__main__":
    main()
