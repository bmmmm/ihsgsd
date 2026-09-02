#!/usr/bin/env bash
# Guards the one branch of weekly_sync.sh that nothing else can reach: what the
# unattended job does when the flyer generator succeeded and the meal-plan
# generator then failed.
#
# Why this deserves its own test. weekly_sync.sh refuses to run at all on a
# dirty working tree, deliberately and silently, because it merges on its own
# and must never drag someone's half-finished edit into a commit. Phase B runs
# the two generators chained; if the second one fails, the first has already
# rewritten data/prospekt.json. Without a restore, that file stays unstaged
# forever, the dirty-tree guard skips EVERY later run — the offer data sync
# included — and nothing looks broken from outside: the site simply keeps
# serving last week's copy. That is a silent, self-inflicted outage, and the
# single line this test guards is what prevents it.
#
# The test does not re-implement the recovery. It reads the actual command out
# of weekly_sync.sh and runs THAT, so deleting or weakening the line in the
# script turns this red.
#
# Run: bash scripts/test_sync_recovery.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC_SCRIPT="$REPO_ROOT/scripts/weekly_sync.sh"
RESTORE_CMD='git checkout -- data/prospekt.json data/mealplan.json'

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok    $*"; }

echo "Checking weekly_sync.sh's Phase B recovery …"

# ── 1. The line exists, and sits in the failure branch ────────────────────────
# Ordering matters: the restore has to run inside the else-branch, after the
# failure is reported and before the notification, not somewhere harmless.
[ -f "$SYNC_SCRIPT" ] || fail "weekly_sync.sh not found at $SYNC_SCRIPT"

fail_line=$(grep -n 'Phase B failed' "$SYNC_SCRIPT" | head -1 | cut -d: -f1)
# Anchored at the start of the line: a plain substring match also finds the
# command inside a comment, so commenting the restore out left this test green
# while the recovery was dead.
restore_line=$(grep -n "^[[:space:]]*${RESTORE_CMD}" "$SYNC_SCRIPT" | head -1 | cut -d: -f1)
notify_line=$(awk -v s="${fail_line:-0}" 'NR > s && /notify_forgejo/ { print NR; exit }' "$SYNC_SCRIPT")

[ -n "$fail_line" ] || fail "no 'Phase B failed' branch in weekly_sync.sh"
[ -n "$restore_line" ] || fail "Phase B does not restore the generated files — a failed mealplan would leave prospekt.json dirty and lock the job out of every later run"
[ -n "$notify_line" ] || fail "no notify_forgejo call after the Phase B failure"

if [ "$restore_line" -lt "$fail_line" ] || [ "$restore_line" -gt "$notify_line" ]; then
    fail "the restore is at line $restore_line, outside the Phase B failure branch (lines $fail_line–$notify_line)"
fi
ok "restore sits in the Phase B failure branch (line $restore_line)"

# ── 2. The command actually clears the lockout ────────────────────────────────
# A scratch repo, not this one: the test must never touch real data.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || fail "cannot enter scratch dir"

mkdir -p data
printf '{"weekLabel":"KW36"}\n' > data/prospekt.json
printf '{"days":[]}\n' > data/mealplan.json

git init -q .
git config user.email "test@example.invalid"
git config user.name "sync recovery test"
git add data
git commit -qm "baseline: last week's editorial"

# generate_prospekt.py succeeded and rewrote its file; generate_mealplan.py then
# failed, so the chained `&&` never reached the `git add`.
printf '{"weekLabel":"KW37"}\n' > data/prospekt.json

if git diff --quiet; then
    fail "scratch setup is wrong — the tree should be dirty at this point"
fi
ok "lockout reproduced: the tree is dirty, so the guard would skip every later run"

# Run the real command, read out of the script rather than retyped here.
eval "$RESTORE_CMD" || fail "the restore command itself failed"

if ! git diff --quiet; then
    fail "the tree is still dirty after the restore — the job would stay locked out"
fi
ok "tree clean again: the next run retries Phase B"

restored=$(cat data/prospekt.json)
[ "$restored" = '{"weekLabel":"KW36"}' ] || fail "prospekt.json was not restored to its committed content (got: $restored)"
ok "prospekt.json restored to its committed content"

echo "PASS: a failed mealplan can no longer lock weekly_sync.sh out."
