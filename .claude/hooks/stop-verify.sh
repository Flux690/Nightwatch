#!/bin/bash
# Fires at the end of every Claude turn.
# Only runs typecheck if .ts files were touched — skips silently otherwise.
# Only writes to the log when typecheck actually runs.

LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
INPUT=$(cat)

SID=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('session_id','')[:8])
" 2>/dev/null || echo "--------")

ACTIVE=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('stop_hook_active', False))
" 2>/dev/null)

if [[ "$ACTIVE" == "True" ]]; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('transcript_path',''))
" 2>/dev/null)

TS_TOUCHED=$(python3 -c "
import json, sys

path = sys.argv[1]
if not path:
    print('unknown')
    sys.exit(0)

try:
    touched = []
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except:
                continue
            if entry.get('type') == 'tool_use':
                tool = entry.get('name', '')
                if tool in ('Write', 'Edit', 'MultiEdit'):
                    fp = entry.get('input', {}).get('file_path', '')
                    if fp.endswith('.ts') or fp.endswith('.tsx'):
                        touched.append(fp)
    print('\n'.join(touched) if touched else '')
except Exception:
    print('unknown')
" "$TRANSCRIPT" 2>/dev/null)

if [[ -z "$TS_TOUCHED" ]]; then
  python3 -c "print(__import__('json').dumps({'systemMessage': '✓ Turn complete'}))"
  exit 0
fi

ERRORS=$(pnpm typecheck 2>&1 | grep "error TS" | head -10)

if [[ -n "$ERRORS" ]]; then
  COUNT=$(echo "$ERRORS" | wc -l | tr -d ' ')
  echo "$TS [$SID] [stop-verify] TYPECHECK FAILED: $COUNT error(s)" >> "$LOG"
  echo "$TS [$SID]   $(echo "$ERRORS" | head -3)" >> "$LOG"

  python3 -c "
import json, sys
errors = sys.argv[1]
count = sys.argv[2]
print(json.dumps({'systemMessage': f'⛔ {count} TypeScript error(s) — turn blocked until fixed'}))
" "$ERRORS" "$COUNT"

  echo "TypeScript errors — fix before stopping:" >&2
  echo "$ERRORS" >&2
  exit 2
fi

echo "$TS [$SID] [stop-verify] typecheck OK" >> "$LOG"
python3 -c "print(__import__('json').dumps({'systemMessage': '✓ Typecheck passed'}))"
exit 0
