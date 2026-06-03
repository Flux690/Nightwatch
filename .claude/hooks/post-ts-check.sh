#!/bin/bash
INPUT=$(cat)
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

npx prettier --write "$FILE" 2>/dev/null

ERRORS=$(cd "$PKG" && npx tsc --noEmit 2>&1 | grep "error TS" | head -15)

if [[ -n "$ERRORS" ]]; then
  python3 -c "
import json, sys
errors = sys.argv[1]
pkg = sys.argv[2]
output = {
  'hookSpecificOutput': {
    'additionalContext': f'TypeScript errors in {pkg} — fix before proceeding:\n{errors}'
  }
}
print(json.dumps(output))
" "$ERRORS" "$PKG"
fi

exit 0
