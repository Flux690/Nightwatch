#!/bin/bash
# Fires after every Write/Edit on a .ts file.
# Runs prettier then tsc. Logs errors (not clean passes — those are noise).

LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
INPUT=$(cat)

SID=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('session_id','')[:8])
" 2>/dev/null || echo "--------")

FILE=$(echo "$INPUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('tool_input',{}).get('file_path',''))
" 2>/dev/null)

if [[ -z "$FILE" || ("$FILE" != *.ts && "$FILE" != *.tsx) ]]; then
  exit 0
fi

if [[ "$FILE" == *"apps/runner"* ]]; then
  PKG="apps/runner"
elif [[ "$FILE" == *"apps/api"* ]]; then
  PKG="apps/api"
elif [[ "$FILE" == *"apps/console"* ]]; then
  PKG="apps/console"
elif [[ "$FILE" == *"packages/shared"* ]]; then
  PKG="packages/shared"
else
  exit 0
fi

SHORT="${FILE##*/}"

pnpm exec prettier --write "$FILE" 2>/dev/null

ERRORS=$(cd "$PKG" && pnpm exec tsc --noEmit 2>&1 | grep "error TS" | head -10)

if [[ -n "$ERRORS" ]]; then
  COUNT=$(echo "$ERRORS" | wc -l | tr -d ' ')
  echo "$TS [$SID] [post-ts-check] ERRORS in $SHORT ($PKG): $COUNT error(s)" >> "$LOG"
  echo "$TS [$SID]   $(echo "$ERRORS" | head -3)" >> "$LOG"

  python3 -c "
import json, sys
errors = sys.argv[1]
pkg = sys.argv[2]
short = sys.argv[3]
count = len([l for l in errors.strip().split('\n') if l.strip()])
print(json.dumps({
    'systemMessage': f'⚠️  tsc: {count} error(s) in {pkg} after editing {short}',
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': f'TypeScript errors in {pkg} — fix before proceeding:\n{errors}'
    }
}))
" "$ERRORS" "$PKG" "$SHORT"
fi

exit 0
