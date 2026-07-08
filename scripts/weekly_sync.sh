#!/usr/bin/env bash
# Syncs the weekly EDEKA data commit that GitHub Actions pushes to `github`
# (it cannot reach the private Forgejo `origin`) and best-effort regenerates
# the prospekt/mealplan editorial, then fans everything back out to both
# remotes. Meant to run unattended via launchd — idempotent, safe to run
# more often than strictly needed.
#
# Phase A (data sync) and Phase B (editorial generation) are independent:
# a week can already be synced without ever having had its prospekt/mealplan
# generated, so Phase B's freshness check compares the latest week in
# folder-structure.json against prospekt.json's own weekLabel rather than
# reusing Phase A's git-ahead check.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOG_FILE="$HOME/ops/logs/ihsgsd-sync.log"
exec >>"$LOG_FILE" 2>&1
echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") weekly_sync start ==="

notify_forgejo() {
  tea issues create --repo bsz/ihsgsd --login fjbsz \
    --title "$1" --description "$2" >/dev/null 2>&1 \
    || echo "WARN: could not file Forgejo notification issue"
}

# git.6bm.de's proxy occasionally breaks on HTTP/2 for smart-HTTP pushes
# (SSL "bad record mac" / HTTP2 framing errors); HTTP/1.1 is reliable.
push_both() {
  local ref="$1"
  if ! git -c http.version=HTTP/1.1 push origin "$ref"; then
    echo "push to origin failed" >&2
    notify_forgejo "weekly_sync: push nach origin (Forgejo) fehlgeschlagen" \
"git push origin $ref ist fehlgeschlagen. Log: $LOG_FILE"
    return 1
  fi
  if ! git -c http.version=HTTP/1.1 push github "$ref"; then
    echo "push to github failed" >&2
    notify_forgejo "weekly_sync: push nach github fehlgeschlagen" \
"git push github $ref ist fehlgeschlagen. Log: $LOG_FILE"
    return 1
  fi
}

if ! git fetch github main --quiet; then
  echo "git fetch github failed" >&2
  notify_forgejo "weekly_sync: git fetch github fehlgeschlagen" "Log: $LOG_FILE"
  exit 1
fi

LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse github/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  BASE=$(git merge-base main github/main)
  if [ "$LOCAL" != "$BASE" ]; then
    echo "main has diverged from github/main, refusing to auto-merge." >&2
    notify_forgejo "weekly_sync: main ist von github/main divergiert" \
"Der automatische Sync-Job (scripts/weekly_sync.sh) konnte nicht per Fast-Forward mergen.
Bitte manuell prüfen: git fetch github && git log main..github/main
Log: $LOG_FILE"
    exit 1
  fi
  git checkout main --quiet
  git merge --ff-only github/main
  push_both main || exit 1
  echo "Phase A ok: data synced to origin + github ($REMOTE)"
else
  echo "Phase A: nothing new from github/main."
fi

LATEST_WEEK=$(python3 -c "
import json
fs = json.load(open('data/folder-structure.json'))
print(sorted(fs)[-1].split('/')[1])
")
CURRENT_WEEK=$(python3 -c "
import json, pathlib
p = pathlib.Path('data/prospekt.json')
print(json.load(p.open()).get('weekLabel', '') if p.exists() else '')
")

if [ "$LATEST_WEEK" = "$CURRENT_WEEK" ]; then
  echo "Phase B: prospekt/mealplan already generated for $LATEST_WEEK, nothing to do."
  echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") weekly_sync end ==="
  exit 0
fi

if python3 scripts/generate_prospekt.py && python3 scripts/generate_mealplan.py; then
  git add data/prospekt.json data/mealplan.json
  if git diff --staged --quiet; then
    echo "Phase B: nothing to commit"
  else
    git commit -m "Generate weekly prospekt & meal plan ($LATEST_WEEK)"
    push_both main || exit 1
    echo "Phase B ok: prospekt+mealplan synced for $LATEST_WEEK"
  fi
else
  echo "Phase B failed (generate_prospekt.py / generate_mealplan.py) for $LATEST_WEEK." >&2
  notify_forgejo "weekly_sync: Prospekt/Mealplan-Generierung fehlgeschlagen ($LATEST_WEEK)" \
"python3 scripts/generate_prospekt.py oder scripts/generate_mealplan.py ist fehlgeschlagen.
Die Offer-Daten wurden trotzdem synchronisiert (Phase A lief durch, falls nötig).
Log: $LOG_FILE"
fi

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") weekly_sync end ==="
