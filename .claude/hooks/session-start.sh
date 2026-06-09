#!/bin/bash
# Fires once when the session starts/resumes. Minimal git orientation only.

INPUT=$(cat)
LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')

SID=$(echo "$INPUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('session_id','')[:8])
" 2>/dev/null || echo "--------")

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
GIT_STATUS=$(git status --short 2>/dev/null || echo "(no git)")
GIT_LOG=$(git log --oneline -5 2>/dev/null || echo "(no log)")

echo "$TS [$SID] [session-start] branch=$BRANCH" >> "$LOG"

CONTEXT="NIGHTWATCH v2 — $BRANCH

Git status:
${GIT_STATUS:-  (clean)}

Last 5 commits:
$GIT_LOG"

python3 -c "
import json, sys
context = sys.argv[1]
branch = sys.argv[2]

print(json.dumps({
    'systemMessage': f'Session: branch={branch}',
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context,
    }
}))
" "$CONTEXT" "$BRANCH"
