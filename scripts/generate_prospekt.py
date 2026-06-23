#!/usr/bin/env python3
"""Generate the weekly EDEKA "Prospekt" editorial via the local `claude` CLI.

Run by hand, e.g. every Monday after the new offers were fetched:

    python3 scripts/build_indexes.py        # (optional) refresh the indexes
    python3 scripts/generate_prospekt.py    # ask claude -p for the flyer copy

It reads the newest week's offer file, filters the products we curate on the
Prospekt page (vegan/vegetarian, Obst & Gemüse, beer & Spezi, Superknüller),
optionally folds in the reader's interests from data/preferences.json (exported
from the Prospekt page's "Für Montag exportieren" button), asks `claude -p`
(Haiku) for a warm German lead, per-section intros and a handful of pick
reasons, and writes data/prospekt.json.

The Prospekt page loads that file OPTIONALLY: if it is missing or malformed the
page still renders all product cards, just without the editorial copy. A failed
run therefore never breaks the site.

Flags:
    --dry-run     Build the digest and print the prompt, but do NOT call claude
                  and do NOT write data/prospekt.json.
    --model M     Override the model (default: sonnet — the ranking task needs
                  the rubric followed; it is one local call per week).
    --prefs PATH  Preferences file to personalise with (default:
                  data/preferences.json; silently skipped if absent).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# build_indexes is the single source of truth for Grundpreis parsing + the
# composite product key; reuse it so the price evidence we feed the model is
# computed exactly like the dashboard's and the page's price-check badge.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_indexes as bx  # noqa: E402

FOLDER_STRUCTURE = REPO_ROOT / "data" / "folder-structure.json"
PREFS_PATH = REPO_ROOT / "data" / "preferences.json"
PRICE_HISTORY_PATH = REPO_ROOT / "data" / "price-history-index.json"
OUT_PATH = REPO_ROOT / "data" / "prospekt.json"

PER_SECTION_CAP = 12   # how many candidates per section we hand to the model
GP_EPS = 1e-9
# evidenceTag values the model may emit; anything else is dropped to "".
EVIDENCE_TAGS = {"Favorit", "mag ich", "guter Preis", "Allzeit-Tief", "Knüller", "Entdeckung", ""}

# Mirror the steering chips in prospekt.js so exported preferences map back to
# human labels in the prompt.
TOPIC_LABELS = {
    "vegan": "Vegan/Vegetarisch",
    "obstgemuese": "Obst & Gemüse",
    "bier": "Bier",
    "spezi": "Spezi",
    "bio": "Bio",
    "knueller": "Superknüller",
    "kaese": "Käse",
    "suess": "Süßes",
    "fleisch": "Fleisch & Wurst",
    "tk": "Tiefkühl",
}

PROMPT_TEMPLATE = """You are the personal shopping recommender for a German supermarket (EDEKA) offers tracker. Return ONLY valid JSON — no prose, no markdown, no text outside the JSON.

The reader especially likes VEGAN/vegetarian products, OBST & GEMÜSE (fruit & veg), and BIER & SPEZI (beer + the Spezi cola-orange drink). The input lists this week's curated candidates per section, each with face price, Grundpreis (GP = EUR/unit, the honest comparator), and — when known — a "ph" price-history object:
- ph.best (bool): the GP is at or below its all-time low across prior offer weeks.
- ph.overPct (int): how many percent the GP is above its own historical low.
- ph.pctile (int): where this GP sits in the product's own history (0 = cheapest it has ever been offered, 100 = most expensive).
- ph.weeks (int): how many prior weeks of history back this up.
A missing "ph" just means there is not enough history — rank such items on preferences, do not invent a price claim for them.

READER_PREFS_PLACEHOLDER

Input data (this week's candidates):
SLICE_PLACEHOLDER

Return exactly this JSON structure (no extra keys, no trailing text):
{
  "generatedAt": "LATEST_DATE_PLACEHOLDER",
  "weekLabel": "WEEK_LABEL_PLACEHOLDER",
  "lead": "<warm, inviting 2-4 sentence German intro to this week's flyer. Mention 1-2 concrete highlights by name. Max 360 chars.>",
  "sections": {
    "vegan": "<1-2 sentence German intro for the vegan/vegetarian picks. Max 200 chars.>",
    "obstgemuese": "<1-2 sentence German intro for fruit & veg. Max 200 chars.>",
    "bierspezi": "<1-2 sentence German intro for beer & Spezi. Max 200 chars.>",
    "knueller": "<1-2 sentence German intro for the Superknüller deals. Max 200 chars.>"
  },
  "foryou": [
    {
      "title": "<exact product title copied verbatim from the input>",
      "rank": 1,
      "reason": "<max 90 char German reason, citing the concrete why: the reader's interest OR a real price fact>",
      "evidenceTag": "<one of: Favorit | mag ich | guter Preis | Allzeit-Tief | Knüller | (empty string)>"
    }
  ],
  "model": "MODEL_PLACEHOLDER"
}

Rules:
- Write ALL text in German, friendly and concrete (not corporate).
- "foryou" is an ORDERED personal recommendation of the 6-10 best products for THIS reader, across all sections. rank starts at 1 (best) and increases by 1 with no gaps. Copy each "title" verbatim from the input so the page can match it.
- Ranking rubric, in priority order:
  1. Honour the reader's preferences: push "Loves (Favorit)" and "Thumbs-up" products to the top; NEVER include products from a section the reader switched off or thumbed down.
  2. Prefer genuinely good prices: ph.best or a low ph.pctile is a strong signal. Only make a price claim ("Allzeit-Tief", "guter Preis") when the item actually has ph evidence supporting it.
  3. A Superknüller is only a real deal if its price also looks good — don't trust the Knüller label alone.
- Pick evidenceTag to match the dominant reason (Favorit/mag ich for preference-driven; Allzeit-Tief for ph.best; guter Preis for low pctile; Knüller for a Superknüller that holds up; empty string if none fits).
- If a section has no candidates, still write a short generic intro for it.
- Numbers/prices: refer to them naturally; never invent a price.
- No fields besides those listed.
"""


def fail(msg):
    """Print an actionable error and exit non-zero without touching outputs."""
    sys.exit(f"generate_prospekt: {msg}")


def load_json(path, hint):
    if not path.exists():
        fail(f"{path.relative_to(REPO_ROOT)} not found — {hint}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{path.relative_to(REPO_ROOT)} is not valid JSON: {exc}")


def file_date(path):
    m = re.search(r"(\d{4}-\d{2}-\d{2})", path)
    return m.group(1) if m else ""


WEEK_FILE_RE = re.compile(r"^\d{4}/KW\d+/\d{4}-\d{2}-\d{2}\.json$")


def latest_week_path(files):
    """Newest 'YYYY/KWNN/YYYY-MM-DD.json' by parsed date (not lexicographic —
    'KW9' would otherwise sort after 'KW26'). Only true week files qualify, so a
    dated non-week artifact can't hijack the selection."""
    paths = [f for f in files if isinstance(f, str) and WEEK_FILE_RE.match(f)]
    if not paths:
        fail("folder-structure.json has no week files matching YYYY/KWNN/YYYY-MM-DD.json")
    return max(paths, key=file_date)


def face_price(offer):
    price = offer.get("price") or {}
    raw = price.get("rawValue")
    if isinstance(raw, (int, float)):
        return round(float(raw), 2)
    try:
        return round(float(price.get("value")), 2)
    except (TypeError, ValueError):
        return None


def load_price_map():
    """{product_key: product} from price-history-index.json, or {} if absent or
    malformed. Optional input: without it the digest simply carries no price
    evidence and the model ranks on preferences alone."""
    if not PRICE_HISTORY_PATH.exists():
        return {}
    try:
        ph = json.loads(PRICE_HISTORY_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out = {}
    for p in ph.get("products", []):
        if isinstance(p, dict) and p.get("key"):
            out[p["key"]] = p
    return out


def price_evidence(offer, price_map, latest_date):
    """Where this offer's Grundpreis sits in the product's own PRIOR-week
    history, or None. Mirrors prospekt.js priceCheck so the page badge and the
    model's reasons agree: exact GPs only, strictly-earlier weeks, >=2 of them."""
    val, unit, flag = bx.parse_gp(offer)
    if val is None or flag != "exact":
        return None
    prod = price_map.get(bx.product_key(offer, unit))
    if not prod:
        return None
    per_week = {}
    for ob in prod.get("obs", []):
        if ob.get("gpf") is not None:          # skip range / "ab €"
            continue
        d = ob.get("d")
        if not d or d >= latest_date:           # only weeks before this one
            continue
        gp = ob.get("gp")
        per_week[d] = gp if d not in per_week else min(per_week[d], gp)
    if len(per_week) < 2:
        return None
    prior = list(per_week.values())
    low = min(prior)
    over_pct = round((val / low - 1) * 100) if low > 0 else 0
    pctile = round(100 * sum(1 for x in prior if x < val) / len(prior))
    return {
        "best": val <= low + GP_EPS,
        "overPct": over_pct,
        "pctile": pctile,
        "weeks": len(prior),
    }


def offer_entry(offer, price_map=None, latest_date=""):
    entry = {
        "title": offer.get("title"),
        "cat": (offer.get("category") or {}).get("name"),
        "price": face_price(offer),
        "gp": offer.get("basicPrice"),
    }
    if price_map:
        ev = price_evidence(offer, price_map, latest_date)
        if ev is not None:
            entry["ph"] = ev
    return entry


def is_knuller(offer):
    crit = offer.get("criteria")
    return isinstance(crit, list) and any(
        isinstance(c, dict) and c.get("name") == "Superknüller" for c in crit
    )


def build_digest(offers, price_map=None, latest_date=""):
    def title_of(o):
        return o.get("title") or ""

    def cat_of(o):
        return (o.get("category") or {}).get("name") or ""

    vegan = [o for o in offers if re.search(r"vegan|vegetar", title_of(o), re.I)]
    obst = [o for o in offers if cat_of(o) == "Obst & Gemüse"]
    bier = [
        o for o in offers
        if re.search(r"spezi", title_of(o), re.I)
        or (cat_of(o) == "Getränke" and re.search(r"\bbier\b|pils", title_of(o), re.I))
    ]
    knueller = [o for o in offers if is_knuller(o)]

    def section(items):
        entries = [offer_entry(o, price_map, latest_date) for o in items]
        # Surface the genuine deals to the model: best-price first, then lowest
        # percentile, then those carrying any evidence. Items without evidence
        # keep their original order at the back. Cap AFTER sorting so the cap
        # keeps the most relevant candidates, not the first ones encountered.
        def rank(e):
            ph = e.get("ph")
            if not ph:
                return (1, 1, 100)
            return (0, 0 if ph.get("best") else 1, ph.get("pctile", 100))
        entries.sort(key=rank)
        return entries[:PER_SECTION_CAP]

    return {
        "vegan": section(vegan),
        "obstgemuese": section(obst),
        "bierspezi": section(bier),
        "knueller": section(knueller),
    }


def prefs_summary(prefs_path):
    """Turn an exported preferences.json into a short German hint block for the
    prompt, or a neutral note if there is nothing to personalise with."""
    if not prefs_path.exists():
        return "Reader preferences: none provided — use the default focus (vegan, Obst & Gemüse, Bier & Spezi)."
    try:
        prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return "Reader preferences: file present but unreadable — use the default focus."

    interests = prefs.get("interests") if isinstance(prefs.get("interests"), dict) else {}
    loves, likes, off = [], [], []
    for key, lvl in interests.items():
        label = TOPIC_LABELS.get(key, key)
        if lvl == 2:
            loves.append(label)
        elif lvl == 1:
            likes.append(label)
        elif lvl == -1:
            off.append(label)

    votes = prefs.get("votes") if isinstance(prefs.get("votes"), dict) else {}
    up, down = [], []
    for key, entry in votes.items():
        if isinstance(entry, dict):          # current shape: {id: {"v": ±1, "t": title}}
            title, v = entry.get("t") or entry.get("title"), entry.get("v")
        else:                                # legacy shape: {title: ±1}
            title, v = key, entry
        if not title:
            continue
        if v == 1:
            up.append(title)
        elif v == -1:
            down.append(title)

    loyal = bought_titles(prefs.get("bought"))

    lines = ["Reader preferences (personalise tone and pick selection accordingly):"]
    if loves:
        lines.append(f"- Loves (Favorit): {', '.join(loves)}")
    if likes:
        lines.append(f"- Likes: {', '.join(likes)}")
    if off:
        lines.append(f"- Not interested (do NOT recommend these): {', '.join(off)}")
    if up:
        lines.append(f"- Thumbs-up products: {', '.join(up[:15])}")
    if down:
        lines.append(f"- Thumbs-down products (avoid): {', '.join(down[:15])}")
    if loyal:
        lines.append(f"- Regularly bought (loyal — highlight these when on offer): {', '.join(loyal[:20])}")
    if len(lines) == 1:
        lines.append("- (no explicit signals yet)")
    return "\n".join(lines)


def bought_titles(bought):
    """Human titles of the reader's 'bought' loyalty signal, newest-count first.
    Accepts the {id: {c, t}} shape written by the page and merged from receipts."""
    if not isinstance(bought, dict):
        return []
    rows = []
    for key, entry in bought.items():
        if isinstance(entry, dict):
            title = entry.get("t") or entry.get("title")
            count = entry.get("c") if isinstance(entry.get("c"), (int, float)) else 1
        else:
            title, count = key, entry if isinstance(entry, (int, float)) else 1
        if title:
            rows.append((count, title))
    rows.sort(key=lambda r: -r[0])
    return [t for _, t in rows]


def prefs_updated_at(prefs_path):
    """The exported prefs' updatedAt stamp, or 'default' if none — lets the
    client detect when localStorage prefs have changed since this was built."""
    if not prefs_path.exists():
        return "default"
    try:
        prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return "default"
    ts = prefs.get("updatedAt")
    return ts if isinstance(ts, str) and ts else "default"


def extract_json(text):
    """Parse the JSON object out of claude's reply, tolerating markdown code
    fences and any prose before/after the object."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^`+[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*`+$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch == "{":
            try:
                obj, _ = decoder.raw_decode(text[i:])
                return obj
            except json.JSONDecodeError:
                continue
    raise json.JSONDecodeError("no JSON object found in output", text, 0)


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    model = "sonnet"
    if "--model" in args:
        i = args.index("--model")
        if i + 1 >= len(args):
            fail("--model needs a value, e.g. --model sonnet")
        model = args[i + 1]
    prefs_path = PREFS_PATH
    if "--prefs" in args:
        i = args.index("--prefs")
        if i + 1 >= len(args):
            fail("--prefs needs a path")
        prefs_path = Path(args[i + 1])

    files = load_json(FOLDER_STRUCTURE, "run `python3 scripts/build_indexes.py` first")
    week_path = latest_week_path(files)
    latest_date = file_date(week_path)
    m = re.search(r"(KW\d+)", week_path)
    week_label = m.group(1) if m else latest_date

    week = load_json(REPO_ROOT / "data" / week_path, "the newest week file is missing")
    offers = week.get("offers")
    if not isinstance(offers, list) or not offers:
        fail(f"{week_path} has no offers")

    price_map = load_price_map()
    digest = build_digest(offers, price_map, latest_date)
    counts = {k: len(v) for k, v in digest.items()}
    n_ev = sum(1 for sec in digest.values() for e in sec if e.get("ph"))
    print(f"Price history: {len(price_map)} products indexed, "
          f"{n_ev} candidate(s) carry price evidence.")
    print(f"Latest week {week_label} ({latest_date}): "
          f"vegan={counts['vegan']}, obst&gemuese={counts['obstgemuese']}, "
          f"bier&spezi={counts['bierspezi']}, knueller={counts['knueller']}.")
    if sum(counts.values()) == 0:
        fail("no curated candidates found — nothing to write (is the latest week empty?)")

    prompt = (PROMPT_TEMPLATE
              .replace("READER_PREFS_PLACEHOLDER", prefs_summary(prefs_path))
              .replace("SLICE_PLACEHOLDER", json.dumps(digest, ensure_ascii=False, indent=1))
              .replace("LATEST_DATE_PLACEHOLDER", latest_date)
              .replace("WEEK_LABEL_PLACEHOLDER", week_label)
              .replace("MODEL_PLACEHOLDER", model))

    if dry_run:
        print(f"\n--- DRY RUN: prompt is {len(prompt)} chars, model would be '{model}'. "
              f"data/prospekt.json NOT written. ---\n")
        print(prompt)
        return

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
        data = extract_json(proc.stdout)
    except json.JSONDecodeError as exc:
        fail(f"could not parse JSON from claude output ({exc}). "
             f"Raw output starts with: {proc.stdout.strip()[:200]!r}")

    if not isinstance(data.get("lead"), str) or not data["lead"]:
        fail("claude output is missing a non-empty 'lead'")
    if not isinstance(data.get("sections"), dict):
        fail("claude output is missing the 'sections' object")
    # Accept either the new 'foryou' (ranked) or, for resilience, a legacy
    # 'picks' array — normalise both to the foryou shape.
    ranked = data.get("foryou")
    if not isinstance(ranked, list):
        ranked = data.get("picks")
    if not isinstance(ranked, list):
        fail("claude output is missing the 'foryou' array")
    for item in ranked:
        if not isinstance(item, dict) or not item.get("title"):
            fail(f"'foryou' has a malformed entry (expected objects with a title): {item!r}")

    # Drop entries whose title is not a verbatim candidate this week: the page
    # matches recommendations on exact title, so a mismatched one would silently
    # render no reason and break the LLM ordering. Dropping it (loudly) is better.
    input_titles = {e["title"] for sec in digest.values() for e in sec if e.get("title")}
    dropped = [p.get("title") for p in ranked if p.get("title") not in input_titles]
    matched = [p for p in ranked if p.get("title") in input_titles]
    if dropped:
        print(f"  note: dropped {len(dropped)} recommendation(s) with non-verbatim titles: {dropped}")

    # Normalise: contiguous 1..n rank, allow-listed evidenceTag, reason <=90 chars.
    foryou = []
    for i, p in enumerate(matched, start=1):
        tag = p.get("evidenceTag") or ""
        if tag not in EVIDENCE_TAGS:
            tag = ""
        reason = p.get("reason") if isinstance(p.get("reason"), str) else ""
        if len(reason) > 90:
            reason = reason[:89].rstrip() + "…"
        foryou.append({"title": p["title"], "rank": i, "reason": reason, "evidenceTag": tag})
    data["foryou"] = foryou
    # Legacy alias so an older cached client (and external consumers) still find
    # reasons under 'picks'; can be dropped after one regeneration cycle.
    data["picks"] = [{"title": p["title"], "reason": p["reason"]} for p in foryou]

    missing = {"vegan", "obstgemuese", "bierspezi", "knueller"} - set(data["sections"].keys())
    if missing:
        print(f"  note: sections missing intros for: {sorted(missing)}")

    data.setdefault("generatedAt", latest_date)
    data.setdefault("weekLabel", week_label)
    data.setdefault("model", model)
    # Stamp which preferences snapshot this was generated for, so the client can
    # tell when localStorage prefs have moved on since Monday.
    data["generatedFor"] = prefs_updated_at(prefs_path)

    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"lead + {len(data.get('sections', {}))} section intros, "
          f"{len(foryou)} ranked recommendations.")


if __name__ == "__main__":
    main()
