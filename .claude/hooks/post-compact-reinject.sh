#!/bin/bash
# Fires after auto-compaction. Reinjects session-specific context that was
# summarized away: branch, recent commits, active phase.
# CLAUDE.md rules are always reloaded by Claude Code — don't repeat them here.

LOG=".claude/logs/hooks.log"
TS=$(date '+%Y-%m-%d %H:%M:%S')

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
RECENT=$(git log --oneline -3 2>/dev/null || echo "no commits")
PHASE=$(grep "## Current Phase:" PLAN.md 2>/dev/null | head -1 | sed 's/## Current Phase: //')
DIRTY=$(git status --short 2>/dev/null | head -5)

echo "$TS [post-compact] branch=$BRANCH phase=\"$PHASE\"" >> "$LOG"

python3 -c "
import json, sys

branch = sys.argv[1]
recent = sys.argv[2]
phase = sys.argv[3]
dirty = sys.argv[4]

lines = [
    f'Context was compacted. Resuming on branch: {branch}',
    f'Current phase: {phase}',
    f'Last 3 commits:\n{recent}',
]
if dirty:
    lines.append(f'Uncommitted changes:\n{dirty}')

print(json.dumps({
    'systemMessage': f'Compacted. branch={branch} | {phase}',
    'hookSpecificOutput': {
        'additionalContext': '\n'.join(lines)
    }
}))
" "$BRANCH" "$RECENT" "$PHASE" "$DIRTY"
