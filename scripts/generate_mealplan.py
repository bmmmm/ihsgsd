#!/usr/bin/env python3
"""Generate the weekly VEGAN meal plan (Mo–So) via the local `claude` CLI.

Run by hand, like the Prospekt generator, after the new offers were fetched:

    python3 scripts/build_indexes.py        # (optional) refresh the indexes
    python3 scripts/generate_mealplan.py    # ask claude -p for the week's plan

It reads the newest week's offers, picks the vegan-friendly candidates (Obst &
Gemüse plus plant-based titles), folds in the reader's tastes from
data/preferences.json (interests, 👍/👎 votes, bought items AND the new per-meal
votes under prefs.meals), and asks `claude -p` for 12-14 distinct vegan dinners.
The first seven become the Mo–So plan, the rest the swap "bench". The result is
written to data/mealplan.json.

The Prospekt page loads that file OPTIONALLY (additive): if it is missing or
malformed the page just hides the meal-plan section — nothing else breaks. The
page also offers a local "↻ Neu generieren" button that POSTs to
scripts/serve.py, which runs this script live.

Flags:
    --dry-run     Build the digest and print the prompt, but do NOT call claude
                  and do NOT write data/mealplan.json.
    --model M     Override the model (default: sonnet).
    --prefs PATH  Preferences file to personalise with (default:
                  data/preferences.json; silently skipped if absent).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_indexes as bx  # noqa: E402
# Reuse the Prospekt generator's plumbing so price evidence, prefs parsing and
# the claude invocation behave identically. Importing it only defines functions
# and constants — its main() runs solely under __main__, so nothing executes.
import generate_prospekt as gp  # noqa: E402

FOLDER_STRUCTURE = REPO_ROOT / "data" / "folder-structure.json"
PREFS_PATH = REPO_ROOT / "data" / "preferences.json"
OUT_PATH = REPO_ROOT / "data" / "mealplan.json"

DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
VEGAN_CANDIDATE_CAP = 40   # vegan-friendly offers handed to the model
BENCH_TARGET = 5           # swap alternatives kept beyond the 7-day plan
MIN_MEALS = 7              # need at least a full week

# Catches the reader's plant-based staples, not just titles that literally say
# "vegan". Mirrors the broadened filter in generate_prospekt.build_digest.
VEGAN_TITLE_RE = re.compile(
    r"vegan|vegetar|tofu|tempeh|seitan|planted|"
    r"hafer(drink|milch)|sojadrink|sojamilch|mandeldrink|pflanzlich|veggie",
    re.I,
)

# Known vegan staples the reader can be assumed to have or easily buy — the
# "pantry" the model may lean on for ingredients that aren't on offer this week.
# Inline for now; move to a tracked data/vegan-pantry.json if it ever grows big.
VEGAN_STAPLES = [
    "Tofu", "Räuchertofu", "Tempeh", "Seitan",
    "Nudeln/Pasta", "Reis", "Couscous", "Bulgur", "Quinoa", "Kartoffeln",
    "Rote Linsen", "Belugalinsen", "Kichererbsen", "Kidneybohnen", "weiße Bohnen",
    "passierte Tomaten", "Tomatenmark", "Kokosmilch", "Gemüsebrühe",
    "Haferflocken", "Haferdrink", "Sojadrink", "Sojajoghurt",
    "Olivenöl", "Rapsöl", "Sojasauce", "Sriracha", "Senf", "Agavendicksaft",
    "Zwiebeln", "Knoblauch", "Ingwer",
    "Salz", "Pfeffer", "Paprikapulver", "Currypulver", "Kreuzkümmel", "Hefeflocken",
]

PROMPT_TEMPLATE = """You are a vegan meal-plan creator for a German EDEKA offers tracker. Return ONLY valid JSON — no prose, no markdown, no text outside the JSON.

Build a one-week vegan dinner plan for ONE reader. EVERY meal MUST be 100% vegan (no meat, fish, dairy, egg, honey). Center the meals on this week's CHEAP vegan offers (listed below, each with face price, Grundpreis GP = EUR/unit, and — when known — a "ph" price-history object where ph.best means the GP is at its all-time low). Fill the rest from the reader's known vegan pantry staples. Honour the reader's tastes.

READER_PREFS_PLACEHOLDER

Known vegan pantry staples you may use freely (these are NOT this week's offers — mark them "pantry": true):
STAPLES_PLACEHOLDER

This week's vegan offers (use these as ingredients where they fit; copy the title VERBATIM into "offerTitle"):
OFFERS_PLACEHOLDER

Return exactly this JSON structure (no extra keys, no trailing text):
{
  "intro": "<warm 1-2 sentence German intro to the week's vegan plan, naming 1-2 concrete offer highlights. Max 220 chars.>",
  "meals": [
    {
      "title": "<short German dish name>",
      "blurb": "<1 German sentence: why it's nice or quick. Max 120 chars.>",
      "tags": ["<lowercase german keyword>"],
      "ingredients": [
        { "name": "Zucchini", "offerTitle": "<verbatim title if this ingredient is one of this week's offers>", "price": "<that offer's price, e.g. €1,49>" },
        { "name": "Couscous", "pantry": true }
      ],
      "steps": ["<short German step>"]
    }
  ]
}

Rules:
- Provide 12-14 DISTINCT vegan dinners with real variety — vary the base across the set: pasta, rice/grains, potatoes, legumes/curry, salad/bowl, soup/stew, oven-roast, stir-fry/wok. Do not build two consecutive meals on the same base.
- ORDER "meals" best-first for THIS reader: their favourites and the cheapest offer-driven dishes first.
- Each meal should use at least one of this week's offers as an ingredient when sensible. Put the VERBATIM offer title in "offerTitle" and its price in "price". Ingredients that are NOT on offer are pantry items: set "pantry": true and omit "offerTitle".
- "tags": 2-4 lowercase German keywords describing the dish (e.g. "ofen", "schnell", "pasta", "asiatisch", "suppe", "salat", "huelsenfruechte", "bowl", "grill").
- "steps": 3-6 short, skimmable German steps.
- Write ALL text in German, concrete and friendly.
- NEVER use a non-vegan ingredient. If an offer is vegetarian-but-not-vegan (cheese, yoghurt, butter, egg), do NOT use it.
- Respect the reader's disliked tags/meals: never include them. Lean into liked tags/meals.
- No fields besides those listed.
"""


def cat_of(o):
    return (o.get("category") or {}).get("name") or ""


def title_of(o):
    return o.get("title") or ""


def vegan_candidates(offers, price_map, latest_date, receipts):
    """This week's vegan-friendly offers as prompt entries, genuine deals first.
    Reuses generate_prospekt.offer_entry so price evidence matches the page."""
    picked = [
        o for o in offers
        if cat_of(o) == "Obst & Gemüse" or VEGAN_TITLE_RE.search(title_of(o))
    ]
    entries = [gp.offer_entry(o, price_map, latest_date, receipts) for o in picked]

    def rank(e):
        ph = e.get("ph")
        if not ph:
            return (1, 1, 100)
        return (0, 0 if ph.get("best") else 1, ph.get("pctile", 100))

    entries.sort(key=rank)
    return entries[:VEGAN_CANDIDATE_CAP]


def meal_learning(prefs_path):
    """German prompt lines from prefs.meals: liked/disliked dish titles plus
    aggregated tag leanings (the durable, cross-week signal). '' if no history."""
    if not prefs_path.exists():
        return ""
    try:
        prefs = json.loads(prefs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ""
    meals = prefs.get("meals")
    if not isinstance(meals, dict) or not meals:
        return ""
    liked_titles, disliked_titles = [], []
    tag_score = {}
    for entry in meals.values():
        if not isinstance(entry, dict):
            continue
        v = entry.get("v")
        title = entry.get("t")
        if v == 1 and title:
            liked_titles.append(title)
        elif v == -1 and title:
            disliked_titles.append(title)
        tags = entry.get("tags") if isinstance(entry.get("tags"), list) else []
        for tag in tags:
            if isinstance(tag, str) and tag:
                tag_score[tag] = tag_score.get(tag, 0) + (1 if v == 1 else -1 if v == -1 else 0)
    liked_tags = [t for t, s in sorted(tag_score.items(), key=lambda kv: -kv[1]) if s > 0]
    disliked_tags = [t for t, s in sorted(tag_score.items(), key=lambda kv: kv[1]) if s < 0]
    lines = []
    if liked_titles:
        lines.append(f"- Meals liked before (offer more like these): {', '.join(liked_titles[:12])}")
    if disliked_titles:
        lines.append(f"- Meals disliked (avoid these and close variants): {', '.join(disliked_titles[:12])}")
    if liked_tags:
        lines.append(f"- Liked meal tags (lean into): {', '.join(liked_tags[:10])}")
    if disliked_tags:
        lines.append(f"- Disliked meal tags (avoid): {', '.join(disliked_tags[:10])}")
    return "\n".join(lines)


_UMLAUT = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}


def slugify(title):
    """Stable, cross-week meal key from the title (the durable handle prefs.meals
    votes are stored under, so a recurring dish keeps learning)."""
    s = (title or "").lower()
    for a, b in _UMLAUT.items():
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "gericht"


def norm_meal(raw, input_titles, demoted):
    """Validate/normalise one meal object from the model. Returns the clean meal
    or None to drop it. `demoted` is a list the function appends offerTitles to
    that claimed an offer not actually on this week's list (kept as pantry)."""
    if not isinstance(raw, dict):
        return None
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    title = title.strip()
    blurb = raw.get("blurb").strip() if isinstance(raw.get("blurb"), str) else ""
    tags = [t.strip().lower() for t in raw.get("tags", [])
            if isinstance(t, str) and t.strip()][:4] if isinstance(raw.get("tags"), list) else []
    steps = [s.strip() for s in raw.get("steps", [])
             if isinstance(s, str) and s.strip()][:8] if isinstance(raw.get("steps"), list) else []

    ingredients = []
    raw_ings = raw.get("ingredients") if isinstance(raw.get("ingredients"), list) else []
    for ing in raw_ings:
        if isinstance(ing, str):
            name = ing.strip()
            if name:
                ingredients.append({"name": name})
            continue
        if not isinstance(ing, dict):
            continue
        name = ing.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        item = {"name": name.strip()}
        offer_title = ing.get("offerTitle")
        if isinstance(offer_title, str) and offer_title in input_titles:
            item["offerTitle"] = offer_title
            price = ing.get("price")
            if isinstance(price, str) and price.strip():
                item["price"] = price.strip()
        else:
            # No verbatim offer match -> it's a pantry/known item. A non-verbatim
            # offerTitle is a hallucinated price claim; drop it (log) and keep the
            # ingredient as pantry so the meal still makes sense.
            if isinstance(offer_title, str) and offer_title:
                demoted.append(offer_title)
            item["pantry"] = True
        ingredients.append(item)

    if not ingredients:
        return None
    return {
        "slug": slugify(title),
        "title": title,
        "blurb": blurb,
        "tags": tags,
        "ingredients": ingredients,
        "steps": steps,
    }


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    model = "sonnet"
    if "--model" in args:
        i = args.index("--model")
        if i + 1 >= len(args):
            gp.fail("--model needs a value, e.g. --model sonnet")
        model = args[i + 1]
    prefs_path = PREFS_PATH
    if "--prefs" in args:
        i = args.index("--prefs")
        if i + 1 >= len(args):
            gp.fail("--prefs needs a path")
        prefs_path = Path(args[i + 1])

    files = gp.load_json(FOLDER_STRUCTURE, "run `python3 scripts/build_indexes.py` first")
    week_path = gp.latest_week_path(files)
    latest_date = gp.file_date(week_path)
    m = re.search(r"(KW\d+)", week_path)
    week_label = m.group(1) if m else latest_date

    week = gp.load_json(REPO_ROOT / "data" / week_path, "the newest week file is missing")
    offers = week.get("offers")
    if not isinstance(offers, list) or not offers:
        gp.fail(f"{week_path} has no offers")

    price_map = gp.load_price_map()
    receipts = gp.load_receipts()
    candidates = vegan_candidates(offers, price_map, latest_date, receipts)
    if not candidates:
        gp.fail("no vegan candidates found this week — nothing to plan")
    input_titles = {c["title"] for c in candidates if c.get("title")}

    n_ev = sum(1 for e in candidates if e.get("ph"))
    print(f"Latest week {week_label} ({latest_date}): "
          f"{len(candidates)} vegan candidate(s), {n_ev} with price evidence.")

    prefs_block = gp.prefs_summary(prefs_path)
    ml = meal_learning(prefs_path)
    if ml:
        prefs_block += "\n" + ml

    prompt = (PROMPT_TEMPLATE
              .replace("READER_PREFS_PLACEHOLDER", prefs_block)
              .replace("STAPLES_PLACEHOLDER", ", ".join(VEGAN_STAPLES))
              .replace("OFFERS_PLACEHOLDER", json.dumps(candidates, ensure_ascii=False, indent=1)))

    if dry_run:
        print(f"\n--- DRY RUN: prompt is {len(prompt)} chars, model would be '{model}'. "
              f"data/mealplan.json NOT written. ---\n")
        print(prompt)
        return

    try:
        proc = subprocess.run(
            ["claude", "-p", prompt, "--model", model],
            capture_output=True, text=True, timeout=600,
        )
    except FileNotFoundError:
        gp.fail("`claude` CLI not found in PATH — install Claude Code or run from a "
                "shell where `claude` is available.")
    except subprocess.TimeoutExpired:
        gp.fail("`claude -p` timed out after 600s — try again or use a smaller model.")

    if proc.returncode != 0:
        gp.fail(f"`claude -p` exited {proc.returncode}: {proc.stderr.strip()[:400]}")

    try:
        data = gp.extract_json(proc.stdout)
    except json.JSONDecodeError as exc:
        gp.fail(f"could not parse JSON from claude output ({exc}). "
                f"Raw output starts with: {proc.stdout.strip()[:200]!r}")

    if not isinstance(data, dict):
        gp.fail(f"claude output was not a JSON object (got {type(data).__name__}).")

    raw_meals = data.get("meals")
    if not isinstance(raw_meals, list) or not raw_meals:
        gp.fail("claude output is missing the 'meals' array")

    demoted = []
    seen_slugs = set()
    meals = []
    for raw in raw_meals:
        meal = norm_meal(raw, input_titles, demoted)
        if not meal or meal["slug"] in seen_slugs:
            continue
        seen_slugs.add(meal["slug"])
        meals.append(meal)

    if demoted:
        print(f"  note: demoted {len(demoted)} ingredient(s) with non-verbatim "
              f"offerTitle to pantry: {sorted(set(demoted))}")
    if len(meals) < MIN_MEALS:
        gp.fail(f"only {len(meals)} valid meal(s) after normalisation — need at "
                f"least {MIN_MEALS} for a Mo–So plan. Try re-running.")

    intro = data.get("intro").strip() if isinstance(data.get("intro"), str) else ""

    out = {
        "weekLabel": week_label,
        "generatedAt": latest_date,
        "generatedFor": gp.prefs_updated_at(prefs_path),
        "model": model,
        "intro": intro,
        "days": [{"day": DAYS[i], "meal": meals[i]} for i in range(7)],
        "bench": meals[7:7 + BENCH_TARGET],
    }

    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"7-day plan + {len(out['bench'])} bench meal(s) "
          f"(from {len(meals)} generated).")


if __name__ == "__main__":
    main()
