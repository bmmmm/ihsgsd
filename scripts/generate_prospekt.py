#!/usr/bin/env python3
"""Generate the weekly EDEKA "Prospekt" editorial via the local `claude` CLI.

Run by hand, e.g. every Monday after the new offers were fetched:

    python3 scripts/build_indexes.py        # (optional) refresh the indexes
    python3 scripts/generate_prospekt.py    # ask claude -p for the flyer copy

It reads the newest week's offer file, filters the products we curate on the
Prospekt page (vegan/vegetarian, Obst & Gemüse, beer & Spezi, Superknüller),
optionally folds in the reader's interests from data/preferences.json (exported
from the Prospekt page's "Für Montag exportieren" button), asks `claude -p`
(opus) for a warm German lead, per-section intros and a handful of pick
reasons, and writes data/prospekt.json.

If the `claude` CLI is missing or fails, run_model() falls back to a local
OpenAI-compatible engine (oMLX by default) rather than to a hosted one — the
prompt is diet-filtered before it is built, so it is not anonymous. The engine
that actually answered is named in the output line.

The Prospekt page loads that file OPTIONALLY: if it is missing or malformed the
page still renders all product cards, just without the editorial copy. A failed
run therefore never breaks the site.

Flags:
    --dry-run     Build the digest and print the prompt, but do NOT call claude
                  and do NOT write data/prospekt.json.
    --model M     Override the model (default: opus — this is a voice task and
                  the gap shows; it is one local call per week).
    --prefs PATH  Preferences file to personalise with (default:
                  data/preferences.json; silently skipped if absent).
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
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
RECEIPTS_PATH = REPO_ROOT / "data" / "receipts.json"
OUT_PATH = REPO_ROOT / "data" / "prospekt.json"

PER_SECTION_CAP = 18   # how many candidates per section we hand to the model
GP_EPS = 1e-9
# evidenceTag values the model may emit; anything else is dropped to "".
EVIDENCE_TAGS = {"Favorit", "mag ich", "guter Preis", "Allzeit-Tief", "Knüller", ""}

# Mirror the steering chips in prospekt.js so exported preferences map back to
# human labels in the prompt.
TOPIC_LABELS = {
    "vegan": "Vegan/Vegetarisch",
    "obstgemuese": "Obst & Gemüse",
    "bier": "Bier",
    "spezi": "Spezi",
    "kaffee": "Kaffee",
    "bio": "Bio",
    "knueller": "Superknüller",
    "kaese": "Käse",
    "suess": "Süßes",
    "fleisch": "Fleisch & Wurst",
    "tk": "Tiefkühl",
    "grundnahrung": "Grundnahrung",
    "drogerie": "Drogerie",
    "tiernahrung": "Tiernahrung",
    "fisch": "Fisch & Meeresfrüchte",
    "spirituosen": "Wein & Spirituosen",
    "getraenke": "Getränke",
}

# Interest level assumed for a topic the exported preferences never decided on
# (e.g. a chip added after the last export). Mirrors DEFAULT_INTERESTS in
# prospekt.js — without it, a brand-new "Wein & Spirituosen: aus" chip would
# read as neutral here and the model would keep recommending Jägermeister.
DEFAULT_INTERESTS = {
    "vegan": 2, "obstgemuese": 2, "bier": 2, "spezi": 2, "kaffee": 2, "bio": 1,
    "fleisch": -1, "kaese": -1, "suess": -1, "drogerie": -1,
    "tiernahrung": -1, "fisch": -1, "spirituosen": -1,
}

# Diet detectors, mirroring prospekt.js — keep the two in sync. Python's \b is
# Unicode-aware, so plain \b is correct here; the JS side needs explicit
# [\p{L}\p{N}] boundaries because its \b is ASCII-only.
#
# These exist because meat and fish do not stay in their own category: fish
# sticks and chicken nuggets are filed under Tiefkühl, Bockwurst and tuna under
# Grundnahrung. Without them the Superknüller section handed the model
# Grillrippen and Fischstäbchen as candidates for a reader who eats neither.
# No brand that sells both: "rügenwalder" used to be in here and made real
# Teewurst (16 weeks) and Pommersche Gutsleberwurst read as vegan, because the
# company sells a meat range next to its plant-based one. Only wording in the
# title, or a brand that is exclusively plant-based, may exempt a product. The
# same word list lives in prospekt.js — test_parity.py compares them.
VEGAN_RE = re.compile(
    r"vegan|vegetar|pflanzlich|veggie|like\s*meat|beyond\s*meat|"
    r"wheaty|taifun|tofu|seitan|tempeh|jackfruit", re.I)
MEAT_RE = re.compile(
    r"\b(?:h[äa]hnchen\w*|h[üu]hner\w*|huhn|pute|puten\w*|truthahn\w*|rind|rinder\w*|"
    r"rinds\w*|schwein\w*|kalb|kalbs\w*|lamm\w*|gans|g[äa]nse\w*|wurst|w[üu]rstchen|"
    r"w[üu]rste|salami|schinken\w*|speck|bacon|hackfleisch|hack|frikadelle\w*|"
    r"bratwurst\w*|bockwurst\w*|leberk[äa]se|nuggets?|schnitzel|gyros\w*|d[öo]ner\w*|"
    r"kasseler|mettwurst|mett|s[üu]lze|geflügel\w*|steaks?|gulasch|braten|cabanossi|"
    r"mortadella|chorizo|prosciutto|salame|landj[äa]ger|rippchen|haxe|keule|"
    r"kotelett\w*|leberwurst|teewurst|fleisch\w*|frankfurter|bratw[üu]rste|"
    r"grillfackel\w*|chicken|beef|pork)\b|\bwiener\b(?!\s*boden)", re.I)
FISH_RE = re.compile(
    r"\b(?:fisch\w*|\w*fisch|lachs\w*|\w*lachs|thunfisch\w*|garnelen?|shrimps?|scampi|"
    r"forelle\w*|hering\w*|matjes|makrele\w*|sardine\w*|sardelle\w*|kabeljau\w*|"
    r"seelachs\w*|scholle|dorsch|zander|pangasius|tintenfisch\w*|muschel\w*|"
    r"krabben\w*|surimi|schlemmerfilet\w*|filegro|meeresfr[üu]chte|calamari|austern?)\b",
    re.I)
SPIRITS_RE = re.compile(
    r"\b(?:likör|liqueur|whisk\w+|vodka|wodka|gin|rum|tequila|brandy|cognac|weinbrand|"
    r"schnaps|korn|aperitif|aperol|campari|jägermeister|fernet|branca|ouzo|grappa|"
    r"sambuca|absinth|bacardi|jack\s*daniel\w*|sekt|prosecco|champagner|crémant|cava|"
    r"winzersekt|wein|weine|weins|rotwein\w*|weißwein\w*|ros[eé]wein\w*|riesling|merlot|"
    r"cabernet|syrah|chardonnay|sauvignon|primitivo|tempranillo|sangria|glühwein|"
    r"portwein|sherry|vermouth|martini|baileys|amaretto)\b", re.I)

# topic key -> (title detector, category). Either match makes the offer a member.
DIET_TOPICS = {
    "fleisch": (MEAT_RE, "Fleisch & Wurst"),
    "fisch": (FISH_RE, "Fisch & Meeresfrüchte"),
    "spirituosen": (SPIRITS_RE, None),
}


def muted_topics(prefs):
    """Topic keys the reader has set (or defaults) to 'aus'."""
    interests = prefs.get("interests") if isinstance(prefs.get("interests"), dict) else {}
    out = set()
    for key in set(DEFAULT_INTERESTS) | set(interests):
        lvl = interests.get(key, DEFAULT_INTERESTS.get(key, 0))
        if lvl == -1:
            out.add(key)
    return out


def looks_vegan(offer):
    """The vegan/vegetarian exemption, over title AND description.

    Deliberately wider than the meat/fish detectors, which read the title only:
    this one can only ever RESCUE a product from a veto, so a false positive
    costs a visible offer while a false negative silently hides a vegan one.
    "alpro Mandel- oder Kokosnuss-Drink" says vegan in its description alone —
    prospekt.js has always read both, and Python reading only the title made the
    generator drop products the page happily showed.
    """
    return bool(VEGAN_RE.search(
        f"{offer.get('title') or ''} {offer.get('description') or ''}"))


def diet_excluded(offer, muted):
    """True when a muted diet topic matches — never for vegan/vegetarian items,
    or muting 'Fleisch' would drop the vegan sausages the reader wants most."""
    title = offer.get("title") or ""
    cat = (offer.get("category") or {}).get("name") or ""
    if looks_vegan(offer):
        return False
    for key, (rx, category) in DIET_TOPICS.items():
        if key in muted and (rx.search(title) or (category and cat == category)):
            return True
    return False

PROMPT_TEMPLATE = """You are the personal shopping recommender for a German supermarket (EDEKA) offers tracker. Return ONLY valid JSON — no prose, no markdown, no text outside the JSON.

The reader especially likes VEGAN/vegetarian products, OBST & GEMÜSE (fruit & veg), BIER & SPEZI (beer + the Spezi cola-orange drink), and KAFFEE (coffee in any form — beans, ground, pads, capsules). The input lists this week's curated candidates per section, each with face price, Grundpreis (GP = EUR/unit, the honest comparator), and — when known — a "ph" price-history object:
- ph.best (bool): the GP is at or below its all-time low across prior offer weeks.
- ph.overPct (int): how many percent the GP is above its own historical low.
- ph.pctile (int): where this GP sits in the product's own history (0 = cheapest it has ever been offered, 100 = most expensive).
- ph.weeks (int): how many prior weeks of history back this up.
A missing "ph" just means there is not enough history — rank such items on preferences, do not invent a price claim for them.
A candidate may also carry "bought": N — the reader has bought this product N times before (from their receipts / loyalty marks). Treat it as a strong personal signal: they clearly want it, so surface it especially when its price also looks good.

READER_PREFS_PLACEHOLDER

Input data (this week's candidates):
SLICE_PLACEHOLDER

Return exactly this JSON structure (no extra keys, no trailing text):
{
  "generatedAt": "LATEST_DATE_PLACEHOLDER",
  "weekLabel": "WEEK_LABEL_PLACEHOLDER",
  "lead": "<4-6 sentence German intro to this week's flyer. Name 4-6 concrete highlights with their price or price fact (e.g. 'Allzeit-Tief', 'nur €1,00'), spread across the reader's interests: fruit & veg, vegan/plant-based, beer/Spezi, and coffee. Max 700 chars of VISIBLE text (link markup does not count).>",
  "sections": {
    "vegan": "<1-2 sentence German intro for the vegan/vegetarian picks. Max 200 chars of visible text.>",
    "obstgemuese": "<1-2 sentence German intro for fruit & veg. Max 200 chars of visible text.>",
    "bierspezi": "<1-2 sentence German intro for beer & Spezi. Max 200 chars of visible text.>",
    "knueller": "<1-2 sentence German intro for the Superknüller deals. Max 200 chars of visible text.>"
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
- Write ALL text in German.

Voice — dry and understated, the way a friend who shops there anyway would put
it. State the good deal plainly, then let ONE aside per two or three sentences
carry the humour: a small observation about the situation, the shop, or the
absurdity of the offer itself. Never zany — no exclamation marks, no puns for
their own sake, no enthusiasm the price does not earn. Understatement, not
jokes. Do not end on a summarising sentence; stop on the last concrete fact.

Aim for this register (invented products, do not reuse them):
  "Der Rosenkohl ist auf einem Allzeit-Tief, was die Frage aufwirft, wer ihn
   sonst kauft. Drei Sorten Pils im Angebot, und das an einem Montag — die
   Woche ist also eingepreist. Die Bio-Möhren kosten 89 Cent das Kilo, ungefähr
   so viel wie eine einzelne Möhre am Bahnhof."
Note what it does: every sentence still delivers a product and a price. The
humour rides along, it never replaces the information.
- BANNED, they read like catalogue copy: "wie gemacht für dich", "warten auf
  dich", "ganz nach deinem Geschmack", "greif zu", "schlemmen", "Genuss pur",
  "das Beste für dich", "freu dich auf", "Kurz:", "wer's ... mag", any sentence
  opening with "Und wer".
- Address the reader as "du" at most twice in the lead. The offers are the
  subject, not the reader.

Product links — every concrete product you name in "lead" or in any "sections"
text MUST be wrapped in this marker, and products may ONLY be named this way:
  [[exact title from the input|the words you want the reader to see]]
Example: [[Wiesenhof - Bruzzzler veggie Würstchen|die veganen Bruzzzler]]
- The part before "|" must be copied character-for-character from a "title" in
  the input. It is never shown; it is how the page finds the offer.
- The part after "|" is what the reader sees. Inflect it to fit your sentence.
- The visible words must keep any diet-defining part of the product name. A
  title saying "veggie", "vegan" or "vegetarisch" describes a MEAT-FREE product
  and the reader avoids meat: writing "Bruzzzler-Würstchen" for
  "Bruzzzler veggie Würstchen" turns a vegan sausage into a meat one. Keep the
  word, or pick different words that carry it ("die pflanzlichen Bruzzzler").
- Never invent a preparation or property that is not in the input ("vom Grill",
  "aus der Pfanne") — describe only what the title and description say.
- Do not use the marker in "foryou" reasons; those are already tied to a product.
- "foryou" is an ORDERED personal recommendation of the 12-16 best products for THIS reader, across all sections. Aim for at least 12 when enough candidates fit the reader's tastes; include every genuinely good match rather than stopping early. rank starts at 1 (best) and increases by 1 with no gaps. Copy each "title" verbatim from the input so the page can match it.
- Ranking rubric, in priority order:
  1. Honour the reader's preferences: push "Loves (Favorit)", "Thumbs-up" and "bought"-before products to the top; NEVER include products from a section the reader switched off or thumbed down.
  2. Prefer genuinely good prices: ph.best or a low ph.pctile is a strong signal. Only make a price claim ("Allzeit-Tief", "guter Preis") when the item actually has ph evidence supporting it.
  3. A Superknüller is only a real deal if its price also looks good — don't trust the Knüller label alone.
- Pick evidenceTag to match the dominant reason (Favorit/mag ich for preference-driven; Allzeit-Tief for ph.best; guter Preis for low pctile; Knüller for a Superknüller that holds up; empty string if none fits).
- If a section has no candidates, still write a short generic intro for it.
- Numbers/prices: refer to them naturally; never invent a price.
- No fields besides those listed.
"""


# Editorial product links: [[exact offer title|words the reader sees]]. The
# title is never rendered — it is how the page finds the offer, so the model
# declares the link itself instead of the page guessing it back out of prose.
LINK_RE = re.compile(r"\[\[([^|\]]+)\|([^\]]+)\]\]")
# Words in a title that decide whether the reader may eat the thing at all.
DIET_WORDS_RE = re.compile(r"veggie|vegan|vegetarisch|fleischfrei", re.I)


def resolve_links(text, titles_by_norm):
    """Validate every link marker in one editorial string.

    Returns (text, problems). Two failures are worth catching, and they differ
    in how bad they are:

    - A marker naming a product that is not among this week's candidates loses
      its link and keeps its prose. A missing link is invisible; a link to the
      wrong offer is not.
    - A label that drops the diet-defining word of its own product is a factual
      error, not a style one: "Wiesenhof - Bruzzzler veggie Würstchen" written
      as "Bruzzzler-Würstchen" turns a vegan sausage into a meat one for a
      reader who avoids meat — which is exactly what shipped in KW31. The label
      is replaced by the real title, which is clumsier to read and always true.
    """
    problems = []

    def sub(m):
        raw_title, label = m.group(1).strip(), m.group(2).strip()
        real = titles_by_norm.get(bx.norm_title(raw_title))
        if not real:
            problems.append(f"unknown product {raw_title!r} — link dropped, prose kept")
            return label
        diet = DIET_WORDS_RE.search(real)
        if diet and not DIET_WORDS_RE.search(label):
            problems.append(
                f"label {label!r} drops {diet.group(0)!r} from {real!r} — using the full title")
            label = real
        return f"[[{real}|{label}]]"

    return LINK_RE.sub(sub, text), problems


def fail(msg):
    """Print an actionable error and exit non-zero without touching outputs.

    Named after the script that is actually running, not this module: the meal
    plan and insights generators call gp.fail() too, and a hardcoded prefix had
    them reporting their own failures as `generate_prospekt:`.
    """
    # argv[0] is "-" under `python3 -` and "" when embedded, which would print a
    # prefix of "-:" — fall back to this module's name unless it looks like one.
    who = Path(sys.argv[0]).stem
    if not who.replace("_", "").replace("-", "").isalnum():
        who = "generate_prospekt"
    sys.exit(f"{who}: {msg}")


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
        if not isinstance(gp, (int, float)):    # skip malformed obs (e.g. gp=null)
            continue
        per_week[d] = gp if d not in per_week else min(per_week[d], gp)
    if len(per_week) < 2:
        return None
    prior = list(per_week.values())
    low = min(prior)
    # Clamp to 0: a fresh all-time low is "0% above the low" (ph.best carries the
    # new-low signal). A negative value would contradict the field's documented
    # "how many percent above the low" meaning and confuse the model.
    over_pct = max(0, round((val / low - 1) * 100)) if low > 0 else 0
    pctile = round(100 * sum(1 for x in prior if x < val) / len(prior))
    return {
        "best": val <= low + GP_EPS,
        "overPct": over_pct,
        "pctile": pctile,
        "weeks": len(prior),
    }


def load_receipts():
    """{norm_title: {name, c, ...}} from the gitignored receipts store, or {}.
    Optional input (scripts/ingest_receipt.py builds it): absent -> no loyalty
    signal from receipts."""
    if not RECEIPTS_PATH.exists():
        return {}
    try:
        data = json.loads(RECEIPTS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    items = data.get("items") if isinstance(data, dict) else None
    return items if isinstance(items, dict) else {}


def receipts_summary(receipts):
    """A prompt line listing the most-bought receipt products, or ''."""
    if not receipts:
        return ""
    rows = []
    for entry in receipts.values():
        if isinstance(entry, dict) and entry.get("name"):
            c = entry.get("c")
            rows.append((c if isinstance(c, (int, float)) else 1, entry["name"]))
    rows.sort(key=lambda r: -r[0])
    if not rows:
        return ""
    names = ", ".join(n for _, n in rows[:20])
    return f"- From receipts (actually bought, strongest loyalty signal): {names}"


def offer_entry(offer, price_map=None, latest_date="", receipts=None):
    entry = {
        "title": offer.get("title"),
        "cat": (offer.get("category") or {}).get("name"),
        "price": bx.face_price(offer),
        "gp": offer.get("basicPrice"),
    }
    if price_map:
        ev = price_evidence(offer, price_map, latest_date)
        if ev is not None:
            entry["ph"] = ev
    if receipts:
        hit = receipts.get(bx.norm_title(offer.get("title")))
        if hit:
            entry["bought"] = hit.get("c") or 1
    return entry


def is_knuller(offer):
    crit = offer.get("criteria")
    return isinstance(crit, list) and any(
        isinstance(c, dict) and c.get("name") == "Superknüller" for c in crit
    )


def build_digest(offers, price_map=None, latest_date="", receipts=None, muted=frozenset()):
    # Drop the reader's diet vetoes before anything else. The page hides these
    # anyway, so leaving them in only wasted candidate slots and invited the
    # model to write lead copy about offers the reader will never see.
    if muted:
        offers = [o for o in offers if not diet_excluded(o, muted)]

    def title_of(o):
        return o.get("title") or ""

    def cat_of(o):
        return (o.get("category") or {}).get("name") or ""

    # Broad enough to catch the reader's plant-based staples, not just titles
    # that literally say "vegan": tofu/tempeh, oat/soy/almond drinks, the big
    # meat-substitute brands. Obst & Gemüse is covered by its own section.
    vegan = [
        o for o in offers
        if re.search(
            r"vegan|vegetar|tofu|tempeh|seitan|planted|"
            r"hafer(drink|milch)|sojadrink|sojamilch|mandeldrink|"
            r"pflanzlich|veggie",
            title_of(o), re.I,
        )
    ]
    obst = [o for o in offers if cat_of(o) == "Obst & Gemüse"]
    # The reader's drinks profile is wider than "Bier": alcohol-free beer,
    # Radler, plus the Bionade / Booster / Spezi soft drinks they favour.
    bier = [
        o for o in offers
        if re.search(r"spezi|bionade|booster", title_of(o), re.I)
        or (
            cat_of(o) == "Getränke"
            and re.search(r"\bbier\b|pils|radler|alkoholfrei|0[,.]0\s*%", title_of(o), re.I)
        )
    ]
    knueller = [o for o in offers if is_knuller(o)]

    def section(items):
        entries = [offer_entry(o, price_map, latest_date, receipts) for o in items]
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


def load_prefs(prefs_path):
    """Exported preferences as a dict, or {} when missing or unreadable. An
    empty dict is fine: muted_topics() then falls back to DEFAULT_INTERESTS,
    which already encodes the reader's standing diet."""
    if not prefs_path.exists():
        return {}
    try:
        data = json.loads(prefs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def prefs_summary(prefs_path):
    """Turn an exported preferences.json into a short German hint block for the
    prompt, or a neutral note if there is nothing to personalise with."""
    if not prefs_path.exists():
        return "Reader preferences: none provided — use the default focus (vegan, Obst & Gemüse, Bier & Spezi, Kaffee)."
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
    """The exported prefs' updatedAt stamp, or 'default' if none. Recorded as
    output metadata only (no client consumes it yet — reserved for a future
    staleness check against the live localStorage prefs)."""
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


# --- model invocation -------------------------------------------------------
#
# All three generators (prospekt, mealplan, insights) call run_model() rather
# than shelling out to `claude` themselves — they used to carry three copies of
# the same subprocess block, which is how the KW32 outage read as three separate
# failures instead of one missing PATH entry.
#
# `claude -p` stays the primary engine. The local fallback exists because the
# whole point of generating here is that the prompt never leaves the machine:
# the digest is diet-filtered before it is built, so the selection itself
# discloses the reader's diet (see the CLAUDE.md note on the :free tier). A
# hosted stand-in would defeat that; a local OpenAI-compatible engine does not.

# oMLX serves on :8010 and requires a key -- NOT the OpenAI client default
# :8000 with no auth. Both facts live in ~/.env as OMLX_URL / OMLX_API_KEY, and
# they are resolved from there rather than expected in the environment because
# launchd hands weekly_sync.sh a bare environment: a fallback that works in a
# shell would still report "no local engine" from the scheduler. That mismatch
# is what made this fallback dead on arrival for KW34 and KW36 -- `claude -p`
# timed out as designed, and the fallback then probed a port nothing listens on.


def _dotenv(name):
    """Resolve NAME from the environment, then ./.env, then ~/.env.

    The oMLX convention (~/ops/reference/omlx.md): clients resolve the key
    themselves so it never appears on a command line. The value is returned but
    never logged -- error messages below name the URL, never the key.
    """
    val = os.environ.get(name)
    if val:
        return val
    for candidate in (REPO_ROOT / ".env", Path.home() / ".env"):
        try:
            text = candidate.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            key, sep, raw = line.strip().partition("=")
            if sep and key.strip() == name:
                return raw.strip().strip('"').strip("'")
    return ""


def _resolve_base_url():
    """Base URL of the local engine, always ending in /v1.

    OMLX_URL is written as a bare origin in ~/.env while OPENAI_BASE_URL
    carries the /v1 by convention -- accept either rather than making a caller
    remember which one this is.
    """
    url = (os.environ.get("OPENAI_BASE_URL") or _dotenv("OMLX_URL")
           or "http://127.0.0.1:8010/v1").rstrip("/")
    return url if url.endswith("/v1") else f"{url}/v1"


LOCAL_BASE_URL = _resolve_base_url()
LOCAL_API_KEY = _dotenv("OPENAI_API_KEY") or _dotenv("OMLX_API_KEY") or "local"
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "")
LOCAL_TIMEOUT = int(os.environ.get("LOCAL_MODEL_TIMEOUT", "900"))
OMLX_BIN = Path.home() / ".omlx" / "bin" / "omlx"


def _local_models():
    """Model ids the local engine currently serves, or [] if it is not up.

    A 401/403 means an engine IS listening but rejects our key — a config
    problem no amount of waking or polling can heal, so it raises with the
    real cause instead of masquerading as "no local engine".
    """
    req = urllib.request.Request(
        f"{LOCAL_BASE_URL}/models",
        headers={"Authorization": f"Bearer {LOCAL_API_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise RuntimeError(
                f"local engine at {LOCAL_BASE_URL} rejected the API key "
                f"(HTTP {exc.code}) — set OMLX_API_KEY in ~/.env "
                f"(or OPENAI_API_KEY in the environment) to the engine's key"
            ) from exc
        return []
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
        return []
    return [m["id"] for m in body.get("data", []) if isinstance(m, dict) and m.get("id")]


def _wake_local_engine():
    """Bring the managed oMLX server up if it is installed but not serving.

    Returns the model ids on offer. `omlx start` is a no-op when the server is
    already running, so this is safe to call on every fallback.
    """
    models = _local_models()
    if models or not OMLX_BIN.exists():
        return models
    try:
        subprocess.run([str(OMLX_BIN), "start"], capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        return []
    # `omlx start` returns once the app reports healthy, but model listing can
    # trail it by a moment — poll briefly rather than failing on a race.
    for _ in range(10):
        models = _local_models()
        if models:
            return models
        time.sleep(2)
    return []


# Engines that are not chat completions at all. They answer /v1/models like any
# other entry, so a fallback that indexes the list can silently pick one and
# then fail on an off-spec reply instead of on a clear "wrong model".
_NON_CHAT_MARKERS = ("bge", "embed", "rerank", "markitdown", "whisper", "clip")

# Parameter counts as they appear in MLX model ids: "27B", "0.5b", "A3B" (the
# active experts of a MoE), but never the "4bit" quantisation suffix -- hence
# the word boundary after the b.
_PARAM_RE = re.compile(r"(\d+(?:\.\d+)?)b\b", re.IGNORECASE)


def _rank_models(models):
    """Order served models best-first for this task: chat-capable, largest.

    Size is a coarse proxy for the JSON-following these prompts need -- a 0.5B
    model returns text the validators reject, which reads as a broken run
    rather than as the wrong pick. LOCAL_MODEL overrides whenever the machine
    knows better.
    """
    def key(model_id):
        low = model_id.lower()
        chat = not any(marker in low for marker in _NON_CHAT_MARKERS)
        sizes = [float(m) for m in _PARAM_RE.findall(model_id)]
        return (chat, max(sizes) if sizes else 0.0)

    return sorted(models, key=key, reverse=True)


# MEASURED 2026-09-01, against the 16-model oMLX roster on this machine:
# the fallback carries generate_insights (2m13s, validators accept the reply)
# but NOT this file's prospekt prompt. Two failure modes, neither a timeout:
#   Qwen3.6-35B-A3B  2m56s -> valid JSON, but no non-empty 'lead' (a MoE with
#                             3B active params; the 35B in the name is not the
#                             size that matters for instruction-following)
#   Qwen3.8-27B      13m47s -> no JSON at all; the reply opens with reasoning
#                             prose ("We need answer user's request...")
# So the blocker is reasoning preamble and prompt complexity, not model size
# or LOCAL_TIMEOUT. Making the prospekt fall back for real needs a
# non-thinking model or a prompt that strips the preamble -- until then a
# `claude -p` outage costs the flyer copy, and the page's stale-editorial
# banner is what tells the reader. Insights still degrade gracefully.
def _run_local(prompt, max_tokens):
    """Ask the local engine for a completion. Returns (text, model_id).

    Raises RuntimeError with an actionable message if the engine cannot serve.
    """
    models = _wake_local_engine()
    if not models:
        raise RuntimeError(
            f"no local engine at {LOCAL_BASE_URL} — start one "
            f"(`omlx start`, or any OpenAI-compatible server), or point "
            f"OMLX_URL / OPENAI_BASE_URL at one"
        )
    # Never hardcode a model: take what the engine actually serves, and let
    # LOCAL_MODEL override when the machine hosts several. But "serves" is not
    # "suitable" -- /v1/models returns the list alphabetically, so the old
    # models[0] picked Qwen2.5-0.5B out of a 16-model roster, and would happily
    # have picked the bge-m3 embedding model on a different machine. Rank
    # instead of indexing.
    model_id = LOCAL_MODEL or _rank_models(models)[0]
    if LOCAL_MODEL and LOCAL_MODEL not in models:
        raise RuntimeError(
            f"LOCAL_MODEL={LOCAL_MODEL!r} is not served at {LOCAL_BASE_URL}; "
            f"available: {', '.join(models)}"
        )
    payload = json.dumps({
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.4,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{LOCAL_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {LOCAL_API_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=LOCAL_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{model_id} returned HTTP {exc.code}: {exc.read()[:200]!r}") from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise RuntimeError(f"{model_id} unreachable after {LOCAL_TIMEOUT}s: {exc}") from exc
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"{model_id} returned an off-spec reply: {str(body)[:200]}") from exc
    return text, model_id


def run_model(prompt, model, timeout=300, max_tokens=8000):
    """Ask `claude -p`; fall back to a local OpenAI-compatible engine.

    Returns (output_text, engine_label). The label names the engine that
    actually answered — callers print it, because silently swapping Opus for a
    local 4-bit model would otherwise look like a normal run.
    """
    claude_err = None
    try:
        proc = subprocess.run(
            ["claude", "-p", prompt, "--model", model],
            capture_output=True, text=True, timeout=timeout,
        )
        if proc.returncode == 0:
            return proc.stdout, f"claude -p --model {model}"
        claude_err = f"`claude -p` exited {proc.returncode}: {proc.stderr.strip()[:200]}"
    except FileNotFoundError:
        claude_err = "`claude` CLI not found in PATH"
    except subprocess.TimeoutExpired:
        claude_err = f"`claude -p` timed out after {timeout}s"

    print(f"  {claude_err} — trying the local engine at {LOCAL_BASE_URL}.", file=sys.stderr)
    try:
        text, model_id = _run_local(prompt, max_tokens)
    except RuntimeError as exc:
        fail(f"{claude_err}, and no local fallback: {exc}. "
             f"Install/repair Claude Code, or start a local engine.")
    return text, f"local {model_id}"


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    # Opus by default: this is a voice task, and the gap shows. Sonnet keeps the
    # facts right but writes them as a list — the dry asides the prompt asks for
    # ("was Montag zu einem vertretbaren Wochentag macht") only appear on Opus.
    # It runs once a week, locally, so the cost is one call.
    model = "opus"
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
    receipts = load_receipts()
    muted = muted_topics(load_prefs(prefs_path))
    n_before = len(offers)
    digest = build_digest(offers, price_map, latest_date, receipts, muted)
    counts = {k: len(v) for k, v in digest.items()}
    n_ev = sum(1 for sec in digest.values() for e in sec if e.get("ph"))
    n_bought = sum(1 for sec in digest.values() for e in sec if e.get("bought"))
    print(f"Price history: {len(price_map)} products indexed, "
          f"{n_ev} candidate(s) carry price evidence.")
    if receipts:
        print(f"Receipts: {len(receipts)} bought product(s) known, "
              f"{n_bought} match this week's candidates.")
    if muted:
        kept = sum(1 for o in offers if not diet_excluded(o, muted))
        print(f"Diet filter ({', '.join(sorted(muted))}): "
              f"{n_before - kept} of {n_before} offer(s) excluded before ranking.")
    print(f"Latest week {week_label} ({latest_date}): "
          f"vegan={counts['vegan']}, obst&gemuese={counts['obstgemuese']}, "
          f"bier&spezi={counts['bierspezi']}, knueller={counts['knueller']}.")
    if sum(counts.values()) == 0:
        fail("no curated candidates found — nothing to write (is the latest week empty?)")

    prefs_block = prefs_summary(prefs_path)
    rcpt_line = receipts_summary(receipts)
    if rcpt_line:
        prefs_block += "\n" + rcpt_line

    prompt = (PROMPT_TEMPLATE
              .replace("READER_PREFS_PLACEHOLDER", prefs_block)
              .replace("SLICE_PLACEHOLDER", json.dumps(digest, ensure_ascii=False, indent=1))
              .replace("LATEST_DATE_PLACEHOLDER", latest_date)
              .replace("WEEK_LABEL_PLACEHOLDER", week_label)
              .replace("MODEL_PLACEHOLDER", model))

    if dry_run:
        print(f"\n--- DRY RUN: prompt is {len(prompt)} chars, model would be '{model}'. "
              f"data/prospekt.json NOT written. ---\n")
        print(prompt)
        return

    raw, engine = run_model(prompt, model, timeout=300)

    try:
        data = extract_json(raw)
    except json.JSONDecodeError as exc:
        fail(f"could not parse JSON from {engine} ({exc}). "
             f"Raw output starts with: {raw.strip()[:200]!r}")

    if not isinstance(data, dict):
        # extract_json returns whatever top-level JSON parsed (a list/scalar is
        # valid JSON); guard before .get() so an off-spec reply fails cleanly
        # via fail() instead of an uncaught AttributeError traceback.
        fail(f"{engine} output was not a JSON object (got {type(data).__name__}). "
             f"Raw output starts with: {raw.strip()[:200]!r}")

    if not isinstance(data.get("lead"), str) or not data["lead"]:
        fail(f"{engine} output is missing a non-empty 'lead'")
    if not isinstance(data.get("sections"), dict):
        fail(f"{engine} output is missing the 'sections' object")
    # Accept either the new 'foryou' (ranked) or, for resilience, a legacy
    # 'picks' array — normalise both to the foryou shape.
    ranked = data.get("foryou")
    if not isinstance(ranked, list):
        ranked = data.get("picks")
    if not isinstance(ranked, list):
        fail(f"{engine} output is missing the 'foryou' array")
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

    # Editorial links — resolve against this week's candidates, not the whole
    # week: a link may only point at something the reader is actually shown.
    titles_by_norm = {}
    for sec in digest.values():
        for e in sec:
            if e.get("title"):
                titles_by_norm.setdefault(bx.norm_title(e["title"]), e["title"])
    link_problems = []
    data["lead"], probs = resolve_links(data["lead"], titles_by_norm)
    link_problems += probs
    for key, val in list(data["sections"].items()):
        if isinstance(val, str):
            data["sections"][key], probs = resolve_links(val, titles_by_norm)
            link_problems += probs
    for p in link_problems:
        print(f"  note: link check — {p}")
    n_links = len(LINK_RE.findall(data["lead"]))
    if n_links:
        print(f"Editorial links: {n_links} in the lead, "
              f"{sum(len(LINK_RE.findall(v)) for v in data['sections'].values() if isinstance(v, str))} "
              f"in the section intros.")
    else:
        print("  note: the lead links no product — the model ignored the "
              "[[title|label]] rule, so nothing in it is clickable or checkable.")

    missing = {"vegan", "obstgemuese", "bierspezi", "knueller"} - set(data["sections"].keys())
    if missing:
        print(f"  note: sections missing intros for: {sorted(missing)}")

    # Authoritative metadata — overwrite whatever the model echoed back. The
    # prompt asks the model to emit these, so setdefault() would keep a
    # hallucinated weekLabel/model and the page would render the wrong week.
    data["generatedAt"] = latest_date
    data["weekLabel"] = week_label
    # `engine`, not `model`: on a fallback run the file was written by a local
    # model while this field still claimed "opus". Nothing renders it, but it
    # is the only record of who wrote a week's copy.
    data["model"] = engine
    # Stamp which preferences snapshot this was generated for (metadata only;
    # reserved for a future client-side staleness check — nothing reads it yet).
    data["generatedFor"] = prefs_updated_at(prefs_path)

    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"lead + {len(data.get('sections', {}))} section intros, "
          f"{len(foryou)} ranked recommendations, via {engine}.")


if __name__ == "__main__":
    main()
