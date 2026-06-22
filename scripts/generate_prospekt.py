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
    --model M     Override the model (default: haiku).
    --prefs PATH  Preferences file to personalise with (default:
                  data/preferences.json; silently skipped if absent).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FOLDER_STRUCTURE = REPO_ROOT / "data" / "folder-structure.json"
PREFS_PATH = REPO_ROOT / "data" / "preferences.json"
OUT_PATH = REPO_ROOT / "data" / "prospekt.json"

PER_SECTION_CAP = 12   # how many candidates per section we hand to the model

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

PROMPT_TEMPLATE = """You write the weekly product flyer ("Prospekt") for a German supermarket (EDEKA) offers tracker. Return ONLY valid JSON — no prose, no markdown, no text outside the JSON.

The reader especially likes VEGAN/vegetarian products, OBST & GEMÜSE (fruit & veg), and BIER & SPEZI (beer + the Spezi cola-orange drink). The input lists this week's curated candidates per section, each with face price and Grundpreis (GP = EUR/unit). GP is the honest comparator.

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
  "picks": [
    {
      "title": "<exact product title copied verbatim from the input>",
      "reason": "<max 90 char German reason why it is worth buying this week>"
    }
  ],
  "model": "MODEL_PLACEHOLDER"
}

Rules:
- Write ALL text in German, in a friendly, concrete flyer tone (not corporate).
- "picks": choose the 6-10 most appealing products ACROSS ALL sections. Copy each "title" verbatim from the input so the page can match it. Prefer items the reader's preferences favour; never recommend items from sections the reader switched off.
- If a section has no candidates, still write a short generic intro for it.
- Numbers/prices: refer to them naturally in prose; do not invent prices.
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


def offer_entry(offer):
    return {
        "title": offer.get("title"),
        "cat": (offer.get("category") or {}).get("name"),
        "price": face_price(offer),
        "gp": offer.get("basicPrice"),
    }


def is_knuller(offer):
    crit = offer.get("criteria")
    return isinstance(crit, list) and any(
        isinstance(c, dict) and c.get("name") == "Superknüller" for c in crit
    )


def build_digest(offers):
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

    return {
        "vegan": [offer_entry(o) for o in vegan[:PER_SECTION_CAP]],
        "obstgemuese": [offer_entry(o) for o in obst[:PER_SECTION_CAP]],
        "bierspezi": [offer_entry(o) for o in bier[:PER_SECTION_CAP]],
        "knueller": [offer_entry(o) for o in knueller[:PER_SECTION_CAP]],
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
    if len(lines) == 1:
        lines.append("- (no explicit signals yet)")
    return "\n".join(lines)


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
    model = "haiku"
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

    digest = build_digest(offers)
    counts = {k: len(v) for k, v in digest.items()}
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
    if not isinstance(data.get("picks"), list):
        fail("'picks' must be a JSON array")
    for item in data["picks"]:
        if not isinstance(item, dict) or not item.get("title"):
            fail(f"'picks' has a malformed entry (expected objects with a title): {item!r}")

    # Drop picks whose title is not a verbatim candidate this week: pickReason()
    # in prospekt.js matches on exact title, so a mismatched pick would silently
    # render no reason. Dropping it (loudly) is better than a dead card.
    input_titles = {e["title"] for sec in digest.values() for e in sec if e.get("title")}
    matched = [p for p in data["picks"] if p.get("title") in input_titles]
    dropped = [p.get("title") for p in data["picks"] if p.get("title") not in input_titles]
    if dropped:
        print(f"  note: dropped {len(dropped)} pick(s) with non-verbatim titles: {dropped}")
    data["picks"] = matched

    missing = {"vegan", "obstgemuese", "bierspezi", "knueller"} - set(data["sections"].keys())
    if missing:
        print(f"  note: sections missing intros for: {sorted(missing)}")

    data.setdefault("generatedAt", latest_date)
    data.setdefault("weekLabel", week_label)
    data.setdefault("model", model)

    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"lead + {len(data.get('sections', {}))} section intros, {len(data['picks'])} picks.")


if __name__ == "__main__":
    main()
