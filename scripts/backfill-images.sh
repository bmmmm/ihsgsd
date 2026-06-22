#!/usr/bin/env bash
# One-time backfill: download the small `app` product thumbnails (~10 KB each)
# for every stored week into a sibling img/<id>.jpg, so they survive EDEKA's
# ~1-2 month purge of the live images. Already-archived images and weeks whose
# live images are already gone (HTTP 404) are skipped. Safe to re-run.
#
# Run:  bash scripts/backfill-images.sh
# Then: git add data/ && git commit -m "Backfill archived product images"
set -uo pipefail

# Repo root = parent of this script's directory (no hardcoded paths).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v jq   >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }

total_ok=0; total_fail=0; total_skip=0; weeks=0

while IFS= read -r f; do
  weeks=$((weeks + 1))
  img_dir="$(dirname "$f")/img"
  mkdir -p "$img_dir"
  ok=0; fail=0; skip=0
  while IFS=$'\t' read -r id url; do
    [ -n "$url" ] || continue
    out="$img_dir/${id}.jpg"
    if [ -f "$out" ]; then skip=$((skip + 1)); continue; fi
    if curl -sf --max-time 30 -o "$out" "$url"; then
      ok=$((ok + 1))
    else
      rm -f "$out"; fail=$((fail + 1))
    fi
  done < <(jq -r '.offers[] | "\(.id)\t\(.images.app // "")"' "$f")
  printf '  %-34s ok=%-4d skip=%-4d fail=%d\n' "$f" "$ok" "$skip" "$fail"
  total_ok=$((total_ok + ok)); total_fail=$((total_fail + fail)); total_skip=$((total_skip + skip))
done < <(find data -path 'data/[0-9]*/KW*/*.json' | sort)

echo
echo "Done over $weeks week(s). downloaded=$total_ok  skipped(existing)=$total_skip  failed(purged/404)=$total_fail"
echo "Stage with: git add data/ && git commit -m \"Backfill archived product images\""
