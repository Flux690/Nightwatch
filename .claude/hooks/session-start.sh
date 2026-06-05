#!/bin/bash
# Fires once when the session starts/resumes.
# Injects git state, current phase, and phase brief into Claude's context.
# If the brief is missing or stale, injects an instruction to regenerate it.

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

CURRENT_PHASE_NUM=$(echo "$PHASE" | grep -oE '[0-9][0-9.]*' | head -1)
BRIEF_PHASE_NUM=$(head -1 ".claude/current-brief.md" 2>/dev/null | grep -oE 'Phase [0-9][0-9.]*' | grep -oE '[0-9][0-9.]*' | head -1)

echo "$TS [$SID] [session-start] branch=$BRANCH phase=\"$PHASE\" brief_phase=\"${BRIEF_PHASE_NUM:-none}\"" >> "$LOG"

CONTEXT="NIGHTWATCH v2 — $BRANCH
Phase: $PHASE

Git status:
${GIT_STATUS:-  (clean)}

Last 5 commits:
$GIT_LOG"

if [[ -z "$BRIEF_PHASE_NUM" ]]; then
  BRIEF_BLOCK="ACTION REQUIRED: No phase brief found.
Before doing anything else, invoke the phase-briefer agent to brief Phase ${CURRENT_PHASE_NUM}."
  echo "$TS [$SID] [session-start] no brief found" >> "$LOG"

elif [[ "$CURRENT_PHASE_NUM" != "$BRIEF_PHASE_NUM" ]]; then
  BRIEF_BLOCK="ACTION REQUIRED: Phase changed ($BRIEF_PHASE_NUM -> $CURRENT_PHASE_NUM).
Before doing anything else, invoke the phase-briefer agent to brief Phase ${CURRENT_PHASE_NUM}."
  echo "$TS [$SID] [session-start] phase changed $BRIEF_PHASE_NUM -> $CURRENT_PHASE_NUM" >> "$LOG"

else
  BRIEF_BLOCK=$(cat ".claude/current-brief.md")
  echo "$TS [$SID] [session-start] brief current for phase $CURRENT_PHASE_NUM" >> "$LOG"
fi

python3 -c "
import json, sys
context = sys.argv[1]
brief_block = sys.argv[2]
branch = sys.argv[3]
phase = sys.argv[4]

print(json.dumps({
    'systemMessage': f'Session: branch={branch} | {phase}',
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': context + '\n\n' + brief_block,
    }
}))
" "$CONTEXT" "$BRIEF_BLOCK" "$BRANCH" "$PHASE"
