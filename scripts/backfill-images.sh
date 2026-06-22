#!/usr/bin/env bash
# One-time backfill: download the small `app` product thumbnails (~10 KB each)
# for every stored week into a sibling img/<id>.jpg, so they survive EDEKA's
# ~1-2 month purge of the live images. Already-archived images and weeks whose
# live images are already gone (HTTP 404) are skipped. Safe to re-run.
#
# Reports per-week HTTP status (ok / purged / rate-limit / err) and throttles
# requests so we don't hammer or get blocked by the image host. Knobs:
#   CUTOFF_DAYS (70)  SLEEP_BETWEEN (0.1)  BACKOFF (5)  MAX_CONSEC_LIMIT (8)
#
# Run:  bash scripts/backfill-images.sh
# Then: git add data/ && git commit -m "Backfill archived product images"
set -uo pipefail

# Repo root = parent of this script's directory (no hardcoded paths).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v jq   >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }

# Only attempt weeks newer than this many days. EDEKA purges live images
# ~1-2 months after an offer ends, so older weeks are guaranteed 404 and
# attempting them just wastes thousands of doomed requests. Re-scan
# everything with:  CUTOFF_DAYS=99999 bash scripts/backfill-images.sh
CUTOFF_DAYS="${CUTOFF_DAYS:-70}"
if   cutoff=$(date -u -v-"${CUTOFF_DAYS}"d +%Y-%m-%d 2>/dev/null); then :          # BSD/macOS
elif cutoff=$(date -u -d "${CUTOFF_DAYS} days ago" +%Y-%m-%d 2>/dev/null); then :  # GNU
else cutoff="0000-00-00"; fi                                                       # no date math -> attempt all
echo "Attempting weeks on/after $cutoff (CUTOFF_DAYS=$CUTOFF_DAYS); older weeks skipped as purged."
echo

# Pacing + rate-limit safety. The image host can throttle a fast loop, so
# sleep a little between requests, back off hard on 429/5xx, and abort the
# whole run after too many limits in a row rather than keep hammering it.
SLEEP_BETWEEN="${SLEEP_BETWEEN:-0.1}"        # seconds between image requests
BACKOFF="${BACKOFF:-5}"                       # seconds to wait after a 429/5xx
MAX_CONSEC_LIMIT="${MAX_CONSEC_LIMIT:-8}"     # abort after this many limits in a row

total_ok=0; total_purged=0; total_limit=0; total_err=0; total_skip=0; weeks=0; old=0
consec_limit=0

while IFS= read -r f; do
  wdate="$(basename "$f" .json)"   # snapshot date == filename, ISO YYYY-MM-DD (lexical compare is safe)
  if [[ "$wdate" < "$cutoff" ]]; then old=$((old + 1)); continue; fi
  weeks=$((weeks + 1))
  img_dir="$(dirname "$f")/img"
  mkdir -p "$img_dir"
  ok=0; purged=0; limit=0; err=0; skip=0
  while IFS=$'\t' read -r id url; do
    [ -n "$url" ] || continue
    out="$img_dir/${id}.jpg"
    if [ -f "$out" ]; then skip=$((skip + 1)); continue; fi
    # -w prints the HTTP status; -o still writes the body, so rm on non-200.
    code=$(curl -s -o "$out" -w '%{http_code}' --max-time 30 "$url" || echo 000)
    case "$code" in
      200) ok=$((ok + 1)); consec_limit=0 ;;
      404|403) rm -f "$out"; purged=$((purged + 1)); consec_limit=0 ;;
      429|500|502|503|504)
        rm -f "$out"; limit=$((limit + 1)); consec_limit=$((consec_limit + 1))
        echo "    RATE-LIMIT/5xx http=$code on offer $id — backing off ${BACKOFF}s (consec=$consec_limit)"
        if [ "$consec_limit" -ge "$MAX_CONSEC_LIMIT" ]; then
          echo "ABORT: $consec_limit consecutive rate-limit/5xx responses — stopping to avoid hammering the host."
          echo "Re-run later; already-downloaded images are kept and skipped on the next run."
          break 2
        fi
        sleep "$BACKOFF" ;;
      *) rm -f "$out"; err=$((err + 1)); echo "    WARN http=$code on offer $id ($url)" ;;
    esac
    sleep "$SLEEP_BETWEEN"
  done < <(jq -r '.offers[] | "\(.id)\t\(.images.app // "")"' "$f")
  printf '  %-34s ok=%-4d purged=%-4d limit=%-3d err=%-3d skip=%-4d\n' "$f" "$ok" "$purged" "$limit" "$err" "$skip"
  total_ok=$((total_ok + ok)); total_purged=$((total_purged + purged))
  total_limit=$((total_limit + limit)); total_err=$((total_err + err)); total_skip=$((total_skip + skip))
done < <(find data -path 'data/[0-9]*/KW*/*.json' | sort)

echo
echo "Done. attempted=$weeks week(s), skipped_old=$old week(s) older than $cutoff."
echo "Images: downloaded=$total_ok  purged(404/403)=$total_purged  rate-limit/5xx=$total_limit  other-err=$total_err  skipped(existing)=$total_skip"
if [ "$total_limit" -gt 0 ]; then
  echo "NOTE: $total_limit request(s) hit rate-limit/5xx — re-run later to pick up what was throttled (downloaded images are kept)."
fi
echo "Stage with: git add data/ && git commit -m \"Backfill archived product images\""
