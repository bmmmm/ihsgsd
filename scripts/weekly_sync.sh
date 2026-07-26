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
# Hardcoded, not relative to BASH_SOURCE: the launchagent-icons wrapper copies
# this script verbatim into an .app bundle elsewhere, so a
# dirname-of-own-location cd would resolve inside that bundle instead of the
# repo (broke the launchd job for weeks — silently exited before Phase A).
# `set -uo pipefail` has no -e, so a failed cd here used to fall through
# silently and run every git command against the wrong cwd ("not a git
# repository"), filing a fresh notify_forgejo issue each time (4 duplicates
# 2026-07-13..07-20, all early-morning launchd wake races) instead of failing
# loud once.
cd "$HOME/offline_coding/ihsgsd" || {
  echo "FATAL: cd to \$HOME/offline_coding/ihsgsd failed, aborting before touching git" >&2
  exit 1
}

LOG_FILE="$HOME/ops/logs/ihsgsd-sync.log"
exec >>"$LOG_FILE" 2>&1
echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") weekly_sync start ==="

# Skips creating a new issue if an open one with the exact same title already
# exists — without this, a recurring failure (e.g. the launchd cd race above)
# re-files a duplicate on every run instead of the one already open.
notify_forgejo() {
  local title="$1" body="$2"
  local existing
  existing=$(tea issues list --repo bsz/ihsgsd --login fjbsz --state open -f title -o tsv 2>/dev/null)
  if printf '%s\n' "$existing" | grep -qxF "$title"; then
    echo "notify_forgejo: open issue '$title' already exists, skipping duplicate"
    return 0
  fi
  tea issues create --repo bsz/ihsgsd --login fjbsz \
    --title "$title" --description "$body" >/dev/null 2>&1 \
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

# Watchdog: the Monday fetch workflow (with its own retries) should have
# landed a snapshot for the current week by Tuesday. Mirrors the workflow's
# own year/week scheme — calendar %Y, ISO week %V (not %G; see the workflow's
# comment on why). Observational only: never aborts, Phases B/C still run.
if [ "$(date -u +%u)" -ge 2 ]; then
  WATCHDOG_YEAR=$(date -u +%Y)
  WATCHDOG_WEEK="KW$(date -u +%V)"
  if grep -q "\"$WATCHDOG_YEAR/$WATCHDOG_WEEK/" data/folder-structure.json; then
    echo "Watchdog: snapshot for $WATCHDOG_YEAR/$WATCHDOG_WEEK present."
  else
    STAMP="$HOME/ops/logs/ihsgsd-missing-$WATCHDOG_YEAR-$WATCHDOG_WEEK.stamp"
    if [ -f "$STAMP" ]; then
      echo "Watchdog: $WATCHDOG_YEAR/$WATCHDOG_WEEK still missing, already notified."
    else
      echo "Watchdog: no snapshot for $WATCHDOG_YEAR/$WATCHDOG_WEEK, notifying." >&2
      notify_forgejo "weekly_sync: Monday-Fetch für $WATCHDOG_YEAR/$WATCHDOG_WEEK fehlt" \
"Für $WATCHDOG_YEAR/$WATCHDOG_WEEK gibt es noch keinen Snapshot in data/folder-structure.json.
Der Monday-Fetch-Workflow ist vermutlich fehlgeschlagen (auch nach seinen eigenen Retries).
Bitte manuell anstoßen: GitHub -> Actions -> Fetch EDEKA Offers -> Run workflow (workflow_dispatch).
Log: $LOG_FILE"
      mkdir -p "$(dirname "$STAMP")"
      touch "$STAMP"
    fi
  fi
else
  echo "Watchdog: skipped (before Tuesday)."
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
elif python3 scripts/generate_prospekt.py && python3 scripts/generate_mealplan.py; then
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

# Phase C: KI-Insights digest (data/insights.json), same freshness pattern as
# Phase B. insights.json's weekLabel is "YYYY-KWnn" — strip the year prefix.
INSIGHTS_WEEK=$(python3 -c "
import json, pathlib
p = pathlib.Path('data/insights.json')
label = json.load(p.open()).get('weekLabel', '') if p.exists() else ''
print(label.split('-', 1)[-1])
")

if [ "$LATEST_WEEK" = "$INSIGHTS_WEEK" ]; then
  echo "Phase C: insights already generated for $LATEST_WEEK, nothing to do."
elif python3 scripts/generate_insights.py; then
  git add data/insights.json
  if git diff --staged --quiet; then
    echo "Phase C: nothing to commit"
  else
    git commit -m "Generate weekly insights ($LATEST_WEEK)"
    push_both main || exit 1
    echo "Phase C ok: insights synced for $LATEST_WEEK"
  fi
else
  echo "Phase C failed (generate_insights.py) for $LATEST_WEEK." >&2
  notify_forgejo "weekly_sync: Insights-Generierung fehlgeschlagen ($LATEST_WEEK)" \
"python3 scripts/generate_insights.py ist fehlgeschlagen.
Prospekt/Mealplan und Daten-Sync sind davon unabhängig gelaufen.
Log: $LOG_FILE"
fi

echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ") weekly_sync end ==="
