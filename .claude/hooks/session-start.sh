#!/bin/bash
# Fires once when the session starts/resumes.
# Writes a single line to the daily log, shows a systemMessage, injects context for Claude.

INPUT=$(cat)
LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')

SID=$(echo "$INPUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('session_id','')[:8])
" 2>/dev/null || echo "--------")

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
PHASE=$(grep "## Current Phase:" PLAN.md 2>/dev/null | head -1 | sed 's/## Current Phase: //')
GIT_STATUS=$(git status --short 2>/dev/null || echo "(no git)")
GIT_LOG=$(git log --oneline -5 2>/dev/null || echo "(no log)")

echo "$TS [$SID] [session-start] branch=$BRANCH phase=\"$PHASE\"" >> "$LOG"

CONTEXT="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NIGHTWATCH v2 — $BRANCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase: $PHASE

Git status:
${GIT_STATUS:-  (clean)}

Last 5 commits:
$GIT_LOG"

python3 -c "
import json, sys
context = sys.argv[1]
branch = sys.argv[2]
phase = sys.argv[3]
print(json.dumps({
    'systemMessage': f'Session: branch={branch} | {phase}',
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context,
    }
}))
" "$CONTEXT" "$BRANCH" "$PHASE"
