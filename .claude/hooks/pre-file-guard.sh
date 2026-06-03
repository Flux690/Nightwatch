#!/bin/bash
# Fires before every Write/Edit tool call.
# Only logs when a file write is BLOCKED — allowed writes are in the transcript.

LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
INPUT=$(cat)

SID=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('session_id','')[:8])
" 2>/dev/null || echo "--------")

FILE=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))
" 2>/dev/null)

SHORT="${FILE##*/}"

PROTECTED=(
  ".env"
  ".env.local"
  ".env.production"
  "pnpm-lock.yaml"
)

for protected in "${PROTECTED[@]}"; do
  if [[ "$FILE" == *"$protected"* ]]; then
    echo "$TS [$SID] [pre-file-guard] BLOCKED: $SHORT (matches $protected)" >> "$LOG"
    python3 -c "
import json, sys
protected = sys.argv[1]
short = sys.argv[2]
print(json.dumps({'systemMessage': f'🛡 Hook blocked write to {short} ({protected} is protected)'}))
" "$protected" "$SHORT"
    echo "BLOCKED: $protected is a protected file." >&2
    echo "Edit it manually if needed." >&2
    exit 2
  fi
done

exit 0
