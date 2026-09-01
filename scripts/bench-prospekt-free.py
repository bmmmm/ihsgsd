#!/usr/bin/env python3
"""Test the weekly Prospekt prompt against OpenRouter :free models via gateii.

Answers one question: can a free model do the editorial job that
`generate_prospekt.py` currently hands to `claude -p --model opus`? It reuses
that script to build the EXACT weekly prompt (offers digest + reader prefs +
strict-JSON schema + ranking rubric), then POSTs it to gateii's /v1/messages for
each candidate :free model — the same path futurenotsub/sweep-free.sh uses:

    x-provider: openrouter        (route to OpenRouter upstream)
    x-gateii-no-fallback: 1       (pin the model, no silent swap on 429)
    x-api-key: <OPENROUTER_API_KEY>

Each reply is scored the way generate_prospekt.py's main() would accept it:
valid JSON, a non-empty `lead`, a `sections` object, a `foryou` array whose
titles are verbatim from the input digest. A direct POST (not `claude -p`) keeps
the test on the prompt+model alone, with none of Claude Code's system-prompt or
tool noise.

Budget: the unfunded OpenRouter free tier is 50 requests/day, account-wide (see
gateii/config/openresty/lua/openrouter_free.lua). This harness reads gateii's
live budget gauge and refuses to start a model when the day window is empty, so
it never hammers an exhausted account. Run it AFTER the UTC-midnight reset, or
once the account holds >=$10 lifetime credits (then the limit is 1000/day).

Usage:
    python3 scripts/bench-prospekt-free.py --dry-run   # build prompt + show plan,
                                                        # spend ZERO free requests
    python3 scripts/bench-prospekt-free.py             # run the default candidate set
    python3 scripts/bench-prospekt-free.py --models cohere/north-mini-code:free
    python3 scripts/bench-prospekt-free.py --max-tokens 4000 --trials 2

Env:
    GATEII_URL   gateii base URL         (required, no default — this repo is
                                          public, so the host stays out of it)
    GATEII_ENV   path to gateii's .env   (default: ../gateii/.env — source of the key)
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import generate_prospekt as gp  # noqa: E402 — reuse the real prompt builder + validators

# Candidate :free models. On 2026-07-20 only the nvidia/nemotron and
# poolside/laguna families were blocked and cohere answered; on 2026-08-03 ALL
# FOUR returned HTTP 404 "No endpoints available matching your guardrail
# restrictions and data policy" in 0.0-0.2s, i.e. OpenRouter rejects before
# reaching a model. :free endpoints are paid for with training rights on the
# prompt, and the account withholds those, so the free tier has no eligible
# endpoint left at all.
#
# Do not "fix" this by flipping the opt-in at openrouter.ai/settings/privacy:
# that switch is account-wide, and the weekly prompt is not anonymous. The
# digest is diet-filtered BEFORE it is built (see generate_prospekt.py's
# diet_excluded()/muted_topics() pass — the JS-side equivalent is prospekt.js's
# vetoedBy — 50 of 199 offers dropped in KW32), so even with the reader
# preference block removed, the surviving selection still discloses the diet.
# Keep the list so a run reports each model as blocked instead of omitting it.
DEFAULT_MODELS = [
    "cohere/north-mini-code:free",             # coding-tuned, 256k — answered until 2026-07-20
    "google/gemma-4-31b-it:free",              # general instruct, 262k
    "openai/gpt-oss-20b:free",                 # general 20b (same class as the local oMLX tier)
    "nvidia/nemotron-3-super-120b-a12b:free",  # 120b/1M
]

GATEII_URL = os.environ.get("GATEII_URL", "").rstrip("/")
GATEII_ENV = Path(os.environ.get("GATEII_ENV", REPO_ROOT.parent / "gateii" / ".env"))
OUT_PATH = REPO_ROOT / "tmp" / "prospekt-free-bench.json"  # tmp/ is gitignored — the
# verdict that matters lives in this file's header and in CLAUDE.md, not here.


def load_key():
    """Read OPENROUTER_API_KEY from the env or gateii's .env — never printed."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    if GATEII_ENV.exists():
        for line in GATEII_ENV.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit(f"bench-prospekt-free: OPENROUTER_API_KEY not set and not found in {GATEII_ENV}")


def build_prompt():
    """Rebuild the exact weekly prompt generate_prospekt.py would send (mirrors
    its main(), model placeholder left as the per-call slug)."""
    files = gp.load_json(gp.FOLDER_STRUCTURE, "run `python3 scripts/build_indexes.py` first")
    week_path = gp.latest_week_path(files)
    latest_date = gp.file_date(week_path)
    import re
    m = re.search(r"(KW\d+)", week_path)
    week_label = m.group(1) if m else latest_date

    week = gp.load_json(REPO_ROOT / "data" / week_path, "the newest week file is missing")
    offers = week.get("offers")
    if not isinstance(offers, list) or not offers:
        sys.exit(f"bench-prospekt-free: {week_path} has no offers")

    price_map = gp.load_price_map()
    receipts = gp.load_receipts()
    # Same diet-veto pass generate_prospekt.py's main() applies — see the
    # DEFAULT_MODELS comment above for why this must not be skipped.
    muted = gp.muted_topics(gp.load_prefs(gp.PREFS_PATH))
    digest = gp.build_digest(offers, price_map, latest_date, receipts, muted)
    if sum(len(v) for v in digest.values()) == 0:
        sys.exit("bench-prospekt-free: no curated candidates in the latest week")

    prefs_block = gp.prefs_summary(gp.PREFS_PATH)
    rcpt_line = gp.receipts_summary(receipts)
    if rcpt_line:
        prefs_block += "\n" + rcpt_line

    template = (gp.PROMPT_TEMPLATE
               .replace("READER_PREFS_PLACEHOLDER", prefs_block)
               .replace("SLICE_PLACEHOLDER", json.dumps(digest, ensure_ascii=False, indent=1))
               .replace("LATEST_DATE_PLACEHOLDER", latest_date)
               .replace("WEEK_LABEL_PLACEHOLDER", week_label))
    input_titles = {e["title"] for sec in digest.values() for e in sec if e.get("title")}
    return template, week_label, input_titles


def gateii_budget():
    """(day_remaining, exhausted) from gateii's /metrics, or (None, None) if the
    proxy is unreachable."""
    try:
        with urllib.request.urlopen(f"{GATEII_URL}/metrics", timeout=6) as r:
            body = r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError):
        return None, None
    rem = exhausted = None
    for line in body.splitlines():
        if line.startswith('gateii_openrouter_free_requests_remaining{window="day"}'):
            rem = int(float(line.rsplit(None, 1)[1]))
        elif line.startswith("gateii_openrouter_free_exhausted "):
            exhausted = int(float(line.rsplit(None, 1)[1]))
    return rem, exhausted


def call_model(model, prompt, key, max_tokens):
    """POST the prompt to gateii for one model. Returns (http_status, latency_s, body_obj)."""
    payload = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = urllib.request.Request(f"{GATEII_URL}/v1/messages", data=payload, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-provider", "openrouter")
    req.add_header("x-gateii-no-fallback", "1")
    req.add_header("x-api-key", key)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, time.monotonic() - t0, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        dt = time.monotonic() - t0
        try:
            return e.code, dt, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, dt, None
    except (urllib.error.URLError, OSError) as e:
        return 0, time.monotonic() - t0, {"error": {"message": str(e)}}


def message_text(body):
    """Concatenate the visible text blocks of an Anthropic /v1/messages reply,
    skipping thinking/redacted_thinking blocks."""
    if not isinstance(body, dict):
        return ""
    content = body.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(b.get("text", "") for b in content
                   if isinstance(b, dict) and b.get("type") == "text")


def score(body, input_titles):
    """Validate a reply the way generate_prospekt.py's main() would. Returns a
    dict of pass flags + the extracted lead (for human eyeballing)."""
    text = message_text(body)
    out = {"valid_json": False, "has_lead": False, "has_sections": False,
           "n_foryou": 0, "verbatim_pct": 0, "lead": "", "note": ""}
    if not text.strip():
        out["note"] = "empty text (may be all-thinking — raise --max-tokens)"
        return out
    try:
        data = gp.extract_json(text)
    except json.JSONDecodeError:
        out["note"] = "no JSON object in reply: " + text.strip()[:90]
        return out
    if not isinstance(data, dict):
        out["note"] = f"top-level JSON was {type(data).__name__}, not object"
        return out
    out["valid_json"] = True
    out["has_lead"] = isinstance(data.get("lead"), str) and bool(data["lead"])
    out["lead"] = (data.get("lead") or "")[:160]
    out["has_sections"] = isinstance(data.get("sections"), dict)
    foryou = data.get("foryou") if isinstance(data.get("foryou"), list) else []
    titled = [p for p in foryou if isinstance(p, dict) and p.get("title")]
    out["n_foryou"] = len(titled)
    if titled:
        verbatim = sum(1 for p in titled if p["title"] in input_titles)
        out["verbatim_pct"] = round(100 * verbatim / len(titled))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", help="comma-separated slugs (default: the built-in candidate set)")
    ap.add_argument("--max-tokens", type=int, default=4000, help="output cap per call (default 4000)")
    ap.add_argument("--trials", type=int, default=1, help="calls per model (default 1)")
    ap.add_argument("--dry-run", action="store_true", help="build prompt + check budget, spend nothing")
    args = ap.parse_args()

    # Checked here rather than at import time so --help still works without it.
    if not GATEII_URL:
        sys.exit("bench-prospekt-free: set GATEII_URL to your gateii base URL, "
                 "e.g. GATEII_URL=http://<host>:8888 python3 scripts/bench-prospekt-free.py")

    models = [m.strip() for m in args.models.split(",")] if args.models else DEFAULT_MODELS
    prompt, week_label, input_titles = build_prompt()
    rem, exhausted = gateii_budget()
    need = len(models) * args.trials

    print(f"gateii:   {GATEII_URL}")
    print(f"week:     {week_label}  |  prompt {len(prompt)} chars, {len(input_titles)} candidate titles")
    print(f"budget:   day_remaining={rem}  exhausted={exhausted}  |  this run needs ~{need} request(s)")
    print(f"models:   {', '.join(models)}")

    if args.dry_run:
        print("\n--- DRY RUN: no model called, no free request spent. ---")
        return

    if rem is None:
        sys.exit(f"bench-prospekt-free: gateii unreachable at {GATEII_URL} — is the stack up?")
    if exhausted or rem <= 0:
        sys.exit("bench-prospekt-free: free-tier budget exhausted — wait for the UTC-midnight reset "
                 "(gateii_openrouter_free_seconds_until_reset) or fund the account for 1000/day.")
    if rem < need:
        print(f"  warning: only {rem} request(s) left < ~{need} needed — will stop when the budget runs out.")

    key = load_key()
    results = []
    for model in models:
        for t in range(args.trials):
            rem, exhausted = gateii_budget()
            if exhausted or (rem is not None and rem <= 0):
                print(f"  budget hit 0 — stopping before {model} trial {t + 1}")
                break
            http, dt, body = call_model(model, prompt, key, args.max_tokens)
            row = {"model": model, "trial": t + 1, "http": http, "latency_s": round(dt, 1)}
            if http == 200:
                row.update(score(body, input_titles))
            else:
                err = (body or {}).get("error", {})
                row["note"] = (err.get("message") if isinstance(err, dict) else str(err)) or "non-200"
            results.append(row)
            flag = "ok " if row.get("valid_json") else "FAIL"
            print(f"  [{flag}] {model:<48} HTTP {http}  {row['latency_s']}s  "
                  f"foryou={row.get('n_foryou', '-')} verbatim={row.get('verbatim_pct', '-')}%  "
                  f"{row.get('note', '')[:60]}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({"week": week_label, "results": results}, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"\nwrote {OUT_PATH.relative_to(REPO_ROOT)}  ({len(results)} run(s))")
    print("\n--- generated leads (eyeball the German editorial quality) ---")
    for r in results:
        if r.get("lead"):
            print(f"\n[{r['model']}]\n{r['lead']}")


if __name__ == "__main__":
    main()
