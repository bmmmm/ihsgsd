#!/usr/bin/env python3
"""Generate weekly KI-Insights for the EDEKA dashboard via the local `claude` CLI.

Run this by hand, e.g. every Monday after the new offers were fetched:

    python3 scripts/build_indexes.py        # refresh the indexes first
    python3 scripts/generate_insights.py    # then ask claude -p for insights

It reads the precomputed indexes (data/price-history-index.json,
data/trend-index.json), builds a small Grundpreis digest of the latest week
(products that got pricier vs. their own history, and products at an all-time
low), asks `claude -p` (Haiku) to turn it into a short German summary plus two
ranked lists, and writes the result to data/insights.json. The dashboard loads
that file optionally — if it is missing or malformed the dashboard just hides
the panel, so a failed run never breaks the site.

Flags:
    --dry-run   Build the digest and print the prompt, but do NOT call claude
                and do NOT write data/insights.json. Use it to validate the
                data pipeline without spending tokens.
    --model M   Override the model (default: haiku).
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PH_PATH = REPO_ROOT / "data" / "price-history-index.json"
TREND_PATH = REPO_ROOT / "data" / "trend-index.json"
OUT_PATH = REPO_ROOT / "data" / "insights.json"

MIN_WEEKS = 3          # need at least this much history to judge "normal"
PRICIER_MIN_PCT = 5.0  # ignore noise: only flag >=5% above own minimum
CANDIDATE_CAP = 15     # how many candidates per list we hand to the model


def _as_finite_float(x):
    """Coerce a number or numeric string to a finite float, else None. Rejects
    bool (int subclass), NaN/Infinity, null and non-numeric strings."""
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x) if math.isfinite(x) else None
    if isinstance(x, str):
        try:
            val = float(x.replace(",", ".").strip())
        except ValueError:
            return None
        return val if math.isfinite(val) else None
    return None


PROMPT_TEMPLATE = """You are a price analyst for a German supermarket (EDEKA) weekly offers tracker. You receive structured price data and must return ONLY valid JSON — no prose, no markdown, no explanation outside the JSON.

The input contains two lists of products with their Grundpreis (GP = honest EUR/unit comparator, e.g. EUR/kg or EUR/l). GP is the only reliable cross-week price signal — face price is NOT comparable.

Input data:
SLICE_PLACEHOLDER

Return exactly this JSON structure (no extra keys, no trailing text):
{
  "generatedAt": "LATEST_DATE_PLACEHOLDER",
  "weekLabel": "WEEK_LABEL_PLACEHOLDER",
  "summary": "<2-3 sentence German summary of notable price movements this week. Mention the biggest GP increase and 1-2 best deals. Max 300 chars.>",
  "pricier": [
    {
      "title": "<product title>",
      "cat": "<category>",
      "current_gp": <number>,
      "unit": "<unit>",
      "hist_min_gp": <number>,
      "pct_above_min": <number>,
      "note": "<max 60 char German note, e.g. 'doppelt so teuer wie im Dezember'>"
    }
  ],
  "deals": [
    {
      "title": "<product title>",
      "cat": "<category>",
      "current_gp": <number>,
      "unit": "<unit>",
      "hist_max_gp": <number>,
      "note": "<max 60 char German note, e.g. '38 % guenstiger als je zuvor'>"
    }
  ],
  "model": "MODEL_PLACEHOLDER"
}

Rules:
- "pricier": include all products from products_above_historical_min_gp, sorted by pct_above_min descending. Max 10.
- "deals": include best products from products_at_alltime_low_gp where hist_max_gp > hist_min_gp (actual price drop). Sort by (hist_max_gp/current_gp) descending. Max 10.
- All text fields in German.
- Numbers as JSON numbers (no strings).
- No fields besides those listed.
- The note must be concrete (mention actual GP values or % change).
"""


def fail(msg):
    """Print an actionable error and exit non-zero without touching outputs."""
    sys.exit(f"generate_insights: {msg}")


def load_json(path, hint):
    if not path.exists():
        fail(f"{path.relative_to(REPO_ROOT)} not found — {hint}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"{path.relative_to(REPO_ROOT)} is not valid JSON: {exc}")


def exact_per_week(product):
    """One exact Grundpreis per distinct week (min if several), date-sorted.

    Mirrors precomputeHistory() in dashboard.js: only observations without a
    `gpf` flag are exact and comparable across weeks.
    """
    per_week = {}
    for obs in product.get("obs", []):
        # build_indexes.py writes "gpf" only for non-exact prices (always a
        # string flag, never null), so key-absence == exact — this mirrors
        # dashboard.js's `o.gpf === undefined` check.
        if "gpf" in obs:  # range / "ab EUR" estimate — not comparable
            continue
        gp = obs.get("gp")
        date = obs.get("d")
        if gp is None or date is None:
            continue
        per_week[date] = gp if date not in per_week else min(per_week[date], gp)
    return per_week


def build_digest(ph, latest, week_label):
    pricier, deals = [], []
    for p in ph.get("products", []):
        per_week = exact_per_week(p)
        if len(per_week) < MIN_WEEKS:
            continue
        values = list(per_week.values())
        hist_min = min(values)
        hist_max = max(values)
        current = per_week.get(latest)
        if current is None:  # not offered this week with an exact GP
            continue
        meta = {"title": p.get("title"), "cat": p.get("cat"), "unit": p.get("unit")}

        if hist_min > 0 and current > hist_min:
            pct = (current / hist_min - 1) * 100
            if pct >= PRICIER_MIN_PCT:
                pricier.append({
                    **meta,
                    "current_gp": round(current, 2),
                    "hist_min_gp": round(hist_min, 2),
                    "pct_above_min": round(pct, 1),
                })

        if current <= hist_min * 1.001 and hist_max > hist_min:
            deals.append({
                **meta,
                "current_gp": round(current, 2),
                "hist_min_gp": round(hist_min, 2),
                "hist_max_gp": round(hist_max, 2),
                "drop_vs_max_pct": round((1 - current / hist_max) * 100, 1),
            })

    pricier.sort(key=lambda x: x["pct_above_min"], reverse=True)
    deals.sort(key=lambda x: x["drop_vs_max_pct"], reverse=True)
    return {
        "latest_date": latest,
        "week_label": week_label,
        "products_above_historical_min_gp": pricier[:CANDIDATE_CAP],
        "products_at_alltime_low_gp": deals[:CANDIDATE_CAP],
    }


def week_label_for(trend, latest):
    for entry in trend:
        if entry.get("date") == latest:
            return entry.get("week", latest)
    return latest


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
    # Scan for the first '{' that begins a valid JSON object, so a stray brace
    # in leading prose doesn't derail parsing.
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

    ph = load_json(PH_PATH, "run `python3 scripts/build_indexes.py` first")
    trend = load_json(TREND_PATH, "run `python3 scripts/build_indexes.py` first")

    latest = ph.get("latestDate")
    if not latest:
        fail("price-history-index.json has no latestDate")
    week_label = week_label_for(trend, latest)

    digest = build_digest(ph, latest, week_label)
    n_pricier = len(digest["products_above_historical_min_gp"])
    n_deals = len(digest["products_at_alltime_low_gp"])
    print(f"Latest week {week_label} ({latest}): "
          f"{n_pricier} pricier candidates, {n_deals} all-time-low candidates.")
    if n_pricier == 0 and n_deals == 0:
        fail("no candidates found — nothing to summarize (is the latest week empty?)")

    prompt = (PROMPT_TEMPLATE
              .replace("SLICE_PLACEHOLDER", json.dumps(digest, ensure_ascii=False, indent=1))
              .replace("LATEST_DATE_PLACEHOLDER", latest)
              .replace("WEEK_LABEL_PLACEHOLDER", week_label)
              .replace("MODEL_PLACEHOLDER", model))

    if dry_run:
        print(f"\n--- DRY RUN: prompt is {len(prompt)} chars, model would be '{model}'. "
              f"data/insights.json NOT written. ---\n")
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

    if not isinstance(data, dict):
        fail(f"claude output was not a JSON object (got {type(data).__name__}). "
             f"Raw output starts with: {proc.stdout.strip()[:200]!r}")

    for key in ("summary", "pricier", "deals"):
        if key not in data:
            fail(f"claude output is missing required key '{key}'")
    if not isinstance(data.get("pricier"), list) or not isinstance(data.get("deals"), list):
        fail("'pricier' and 'deals' must be JSON arrays")
    for key in ("pricier", "deals"):
        for item in data[key]:
            if not isinstance(item, dict) or not item.get("title"):
                fail(f"'{key}' has a malformed entry (expected objects with a title): {item!r}")

    # Sanitise the model's numeric fields: coerce a number or numeric string to a
    # finite float, drop anything else (null, NaN/Infinity, garbage). The dashboard
    # guards on `typeof === 'number'`, so a leftover "2.99" string or null would
    # silently blank the price/badge — clean it at the source rather than trust the
    # model to honour "Numbers as JSON numbers".
    for key in ("pricier", "deals"):
        for item in data[key]:
            for field in ("current_gp", "hist_min_gp", "hist_max_gp", "pct_above_min"):
                if field in item:
                    val = _as_finite_float(item[field])
                    if val is None:
                        item.pop(field, None)
                    else:
                        item[field] = val

    # Authoritative metadata — overwrite the model's echo, never setdefault (it
    # is prompted to emit these, so setdefault would keep a hallucinated value).
    data["generatedAt"] = latest
    data["weekLabel"] = week_label
    data["model"] = model

    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"{len(data['pricier'])} pricier, {len(data['deals'])} deals.")


if __name__ == "__main__":
    main()
