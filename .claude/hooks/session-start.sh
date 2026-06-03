#!/bin/bash
# Fires once when the session starts/resumes.
# - Writes to .claude/logs/hooks.log (tail -f that file to watch hooks live)
# - Shows a brief systemMessage visible to the user in the UI
# - Injects full context as additionalContext for Claude
# - Warns Claude if PLAN.md phase is stale

LOG=".claude/logs/hooks.log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
PHASE=$(grep "## Current Phase:" PLAN.md 2>/dev/null | head -1 | sed 's/## Current Phase: //')
GIT_STATUS=$(git status --short 2>/dev/null || echo "(no git)")
GIT_LOG=$(git log --oneline -5 2>/dev/null || echo "(no log)")

echo "$TS [session-start] branch=$BRANCH phase=\"$PHASE\"" >> "$LOG"

# Detect stale PLAN.md: check key files that exist only after each phase completes
STALE=""
if [[ -f "apps/api/src/investigation/loop.ts" ]] && echo "$PHASE" | grep -qE "^[123] "; then
  STALE="⚠️  PLAN.md still shows Phase $PHASE but Phase 2+3 files exist. Update PLAN.md now."
  echo "$TS [session-start] STALE PLAN.md detected" >> "$LOG"
fi

# Build full context block for Claude (additionalContext)
CONTEXT="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NIGHTWATCH v2 — $BRANCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase: $PHASE

Git status:
${GIT_STATUS:-  (clean)}

Last 5 commits:
$GIT_LOG"

if [[ -n "$STALE" ]]; then
  CONTEXT="$CONTEXT

$STALE"
fi

# Output JSON — additionalContext goes to Claude, systemMessage shows to user
python3 -c "
import json, sys

context = sys.argv[1]
branch = sys.argv[2]
phase = sys.argv[3]
stale = sys.argv[4]

user_msg = f'Session: branch={branch} | {phase}'
if stale:
    user_msg += ' | ⚠️ PLAN.md stale'

print(json.dumps({
    'systemMessage': user_msg,
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context,
    }
}))
" "$CONTEXT" "$BRANCH" "$PHASE" "$STALE"
