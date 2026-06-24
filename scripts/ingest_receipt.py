#!/usr/bin/env python3
"""Ingest a supermarket receipt photo into the local loyalty store.

    python3 scripts/ingest_receipt.py receipt.jpg [more.jpg ...]

Calls `claude -p` (vision) to read each image into line items, normalises the
product names with the SAME key build_indexes uses, and merges them into
data/receipts.json (gitignored — personal data). generate_prospekt.py reads
that store on Mondays so the flyer can highlight what you actually buy.

The model reads the image via its Read tool, so pass a path it can open. A
failed/garbled extraction never corrupts the store: parsing is validated, the
same receipt is not double-counted (content fingerprint), and the store is
written atomically (temp file + os.replace) so a crash mid-write cannot
truncate it.

Flags:
    --dry-run        Print the prompt(s); do not call claude or write anything.
    --model M        Vision model (default: sonnet).
    --store PATH     Receipt store (default: data/receipts.json).
    --force          Ingest even if this receipt's content was already ingested.
    --from-json P    Skip the model and ingest an already-extracted JSON file
                     (same shape the model returns) — for testing the
                     normalise+merge path deterministically.
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_indexes as bx  # noqa: E402

DEFAULT_STORE = REPO_ROOT / "data" / "receipts.json"


def _finite_num(x):
    """True only for a real finite int/float. Rejects bool (a bool is an int
    subclass, so isinstance(True, int) is True) and NaN/Infinity (which
    json.load admits by default) — a model that emits qty:true or price:NaN
    must not poison the counts/spent totals."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)

# Defense in depth: even if the model misclassifies, never store these
# non-product receipt lines in the loyalty store. "pfand" is a substring (no
# \b) so it also catches the common compounds Flaschen-/Einweg-/Mehrweg-/
# Getränkepfand and Pfandrückgabe. Bare "bar"/"karte" are deliberately omitted
# to avoid eating real product names ("... Bar", "Grußkarte").
NON_PRODUCT_RE = re.compile(
    r"(pfand|\bleergut\b|\brabatt\b|\bcoupon\b|\bgutschein\b|\bsumme\b|\bgesamt\b|"
    r"\bzwischensumme\b|\bpayback\b|\bkartenzahlung\b|\bec[- ]?cash\b|\bwechselgeld\b|"
    r"\br[uü]ckgeld\b|\bmwst\b|\bmehrwertsteuer\b|\bnetto\b|\bbrutto\b|\bbargeld\b|"
    r"\bgegeben\b|\bvisa\b|\bmastercard\b|\bgirocard\b|\bmaestro\b|\btrinkgeld\b)",
    re.IGNORECASE,
)

PROMPT_TEMPLATE = """Read the supermarket receipt image at this path and extract its line items: {path}

Return ONLY valid JSON, no prose or markdown:
{{"store": "<store name or empty string>", "date": "<YYYY-MM-DD or empty string>", "items": [{{"name": "<product name as printed>", "qty": <quantity as a number, default 1>, "price": <line total in EUR as a number, or null>}}]}}

Rules:
- One entry per product line. Skip non-product lines (subtotal, total, change, payment method, loyalty points). A Pfand/deposit line is not a product.
- Keep product names roughly as printed; do not invent items not on the receipt.
- German receipts use a comma decimal separator; output plain numbers (e.g. 12.50)."""


def fail(msg):
    sys.exit(f"ingest_receipt: {msg}")


def extract_json(text):
    """Parse the JSON object out of the model reply, tolerating code fences and
    surrounding prose."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^`+[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*`+$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Scan all candidate objects; prefer the one that actually carries an
    # 'items' list (the receipt payload), so a stray valid object the model may
    # emit first — an echoed example, a tool-style preamble — does not win.
    decoder = json.JSONDecoder()
    first = None
    for i, ch in enumerate(text):
        if ch == "{":
            try:
                obj, _ = decoder.raw_decode(text[i:])
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and isinstance(obj.get("items"), list):
                return obj
            if first is None:
                first = obj
    if first is not None:
        return first
    raise json.JSONDecodeError("no JSON object found in output", text, 0)


def load_store(path):
    if not path.exists():
        return {"items": {}, "sources": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        fail(f"{path} is not valid JSON — move it aside or fix it before ingesting.")
    if not isinstance(data, dict):
        data = {}
    data.setdefault("items", {})
    data.setdefault("sources", [])
    return data


def write_store(path, store):
    """Write the store atomically: a temp file in the same directory + os.replace
    so a crash/ENOSPC mid-write cannot truncate the (gitignored, un-backed-up)
    receipts.json. os.replace is atomic within a filesystem."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def receipt_fingerprint(parsed):
    """A stable content hash of one receipt (store + date + sorted item lines),
    so re-ingesting the same photo/JSON is detected and skipped. Independent of
    key order; tolerant of a model that omits store/date."""
    obj = parsed if isinstance(parsed, dict) else {}
    items = obj.get("items") if isinstance(obj.get("items"), list) else []
    basis = {
        "store": (obj.get("store") or "").strip().lower(),
        "date": (obj.get("date") or "").strip(),
        "items": sorted(
            f"{(it.get('name') or '').strip().lower()}|{it.get('qty')}|{it.get('price')}"
            for it in items if isinstance(it, dict)
        ),
    }
    blob = json.dumps(basis, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def call_claude(image_path, model):
    prompt = PROMPT_TEMPLATE.format(path=image_path)
    try:
        proc = subprocess.run(
            ["claude", "-p", prompt, "--model", model],
            capture_output=True, text=True, timeout=300,
        )
    except FileNotFoundError:
        fail("`claude` CLI not found in PATH — install Claude Code or run from a "
             "shell where `claude` is available.")
    except subprocess.TimeoutExpired:
        fail("`claude -p` timed out after 300s — try again or use a smaller model.")
    if proc.returncode != 0:
        fail(f"`claude -p` exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    try:
        return extract_json(proc.stdout)
    except json.JSONDecodeError as exc:
        fail(f"could not parse JSON from claude output ({exc}). "
             f"Raw output starts with: {proc.stdout.strip()[:200]!r}")


def merge(store, parsed, source_label, force=False):
    """Fold one receipt's items into the store, keyed by the build_indexes
    normalised title so a product matches its weekly-offer counterpart.

    Idempotent: a receipt whose content fingerprint was already ingested is
    skipped (returns 0) unless force=True — re-running on the same photo must
    not double-count the loyalty signal."""
    items = parsed.get("items") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        fail(f"extracted data for {source_label} has no 'items' list")
    fp = receipt_fingerprint(parsed)
    seen = {s.get("fp") for s in store.get("sources", []) if isinstance(s, dict)}
    if fp in seen and not force:
        print(f"  skip {source_label}: identical receipt already ingested; "
              f"pass --force to add it again.")
        return 0
    added = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        name = (it.get("name") or "").strip()
        if not name or NON_PRODUCT_RE.search(name):
            continue
        key = bx.norm_title(name)
        if not key:
            continue
        qty = it.get("qty")
        qty = qty if _finite_num(qty) and qty > 0 else 1
        praw = it.get("price")
        price = praw if _finite_num(praw) and praw >= 0 else None
        entry = store["items"].get(key)
        if entry is None:
            entry = store["items"][key] = {"name": name, "c": 0, "qty": 0, "spent": 0.0}
        entry["name"] = name              # keep the freshest printed spelling
        entry["c"] += 1
        entry["qty"] += qty
        if price is not None:
            entry["spent"] = round(entry.get("spent", 0.0) + price, 2)
        added += 1
    store["sources"].append({"source": source_label, "items": added, "fp": fp})
    return added


def parse_args(argv):
    opts = {"dry_run": False, "model": "sonnet", "store": DEFAULT_STORE,
            "from_json": None, "images": [], "force": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--dry-run":
            opts["dry_run"] = True
        elif a == "--force":
            opts["force"] = True
        elif a == "--model":
            i += 1
            if i >= len(argv) or argv[i].startswith("--"):
                fail("--model needs a value, e.g. --model sonnet")
            opts["model"] = argv[i]
        elif a == "--store":
            i += 1
            if i >= len(argv) or argv[i].startswith("--"):
                fail("--store needs a path")
            opts["store"] = Path(argv[i])
        elif a == "--from-json":
            i += 1
            if i >= len(argv) or argv[i].startswith("--"):
                fail("--from-json needs a path")
            opts["from_json"] = Path(argv[i])
        elif a.startswith("--"):
            fail(f"unknown flag {a!r}")
        else:
            opts["images"].append(a)
        i += 1
    return opts


def main():
    opts = parse_args(sys.argv[1:])
    store_path = opts["store"]

    if opts["from_json"]:
        if opts["images"]:
            fail("--from-json cannot be combined with image arguments — "
                 "ingest the JSON or the photos in separate runs.")
        if not opts["from_json"].exists():
            fail(f"--from-json file not found: {opts['from_json']}")
        try:
            parsed = json.loads(opts["from_json"].read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            fail(f"--from-json file is not valid JSON: {exc}")
        store = load_store(store_path)
        n = merge(store, parsed, f"json:{opts['from_json'].name}", force=opts["force"])
        write_store(store_path, store)
        print(f"Ingested {n} item(s) from {opts['from_json']} -> "
              f"{store_path} ({len(store['items'])} unique products).")
        return

    images = opts["images"]
    if not images:
        fail("no receipt image given. Usage: ingest_receipt.py [--dry-run] IMAGE [IMAGE ...]")
    for img in images:
        if not Path(img).exists():
            fail(f"image not found: {img}")

    if opts["dry_run"]:
        for img in images:
            print(PROMPT_TEMPLATE.format(path=str(Path(img).resolve())))
            print("---")
        print(f"DRY RUN: would call claude --model {opts['model']} for "
              f"{len(images)} image(s); nothing written.")
        return

    store = load_store(store_path)
    total = 0
    for img in images:
        parsed = call_claude(str(Path(img).resolve()), opts["model"])
        total += merge(store, parsed, Path(img).name, force=opts["force"])
    write_store(store_path, store)
    print(f"Ingested {total} item(s) from {len(images)} image(s) -> "
          f"{store_path} ({len(store['items'])} unique products). "
          f"Run generate_prospekt.py to use them.")


if __name__ == "__main__":
    main()
