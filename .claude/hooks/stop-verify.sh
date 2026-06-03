#!/bin/bash
INPUT=$(cat)

ACTIVE=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('stop_hook_active', False))
" 2>/dev/null)

if [[ "$ACTIVE" == "True" ]]; then
  exit 0
fi

ERRORS=$(pnpm typecheck 2>&1 | grep "error TS" | head -10)

if [[ -n "$ERRORS" ]]; then
  echo "TypeScript errors found — cannot stop:" >&2
  echo "$ERRORS" >&2
  exit 2
fi

exit 0
