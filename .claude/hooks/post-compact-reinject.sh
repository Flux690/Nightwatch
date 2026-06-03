#!/bin/bash
# CLAUDE.md rules are never compacted — don't reinject them here.
# This hook reinjects session-specific context that WAS in the conversation
# and may have been summarized away: current branch, recent commits, active phase.

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
RECENT=$(git log --oneline -3 2>/dev/null || echo "no commits")
PHASE=$(grep -A1 "## Current Phase" PLAN.md 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//')
DIRTY=$(git status --short 2>/dev/null | head -5)

python3 -c "
import json, sys

branch = sys.argv[1]
recent = sys.argv[2]
phase = sys.argv[3]
dirty = sys.argv[4]

lines = [
    f'Context was compacted. Resuming on branch: {branch}',
    f'Current phase: {phase}',
    f'Last 3 commits: {recent}',
]
if dirty:
    lines.append(f'Uncommitted changes: {dirty}')

output = {
    'hookSpecificOutput': {
        'additionalContext': '\n'.join(lines)
    }
}
print(json.dumps(output))
" "$BRANCH" "$RECENT" "$PHASE" "$DIRTY"
