#!/bin/bash
# Fires at the end of EVERY Claude turn (when Claude stops responding).
# Uses transcript_path to check if any .ts files were touched this turn.
# Only runs typecheck if they were — skips otherwise to keep turns fast.

LOG=".claude/logs/hooks.log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
INPUT=$(cat)

# Prevent recursive triggering (if Stop hook itself causes a turn)
ACTIVE=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('stop_hook_active', False))
" 2>/dev/null)

if [[ "$ACTIVE" == "True" ]]; then
  echo "$TS [stop-verify] skipped (stop_hook_active)" >> "$LOG"
  exit 0
fi

# Extract transcript path from hook input
TRANSCRIPT=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('transcript_path',''))
" 2>/dev/null)

# Check if any .ts/.tsx files were written/edited this turn by reading transcript
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
            # Look for Write/Edit tool calls in this turn
            if entry.get('type') == 'tool_use':
                tool = entry.get('name', '')
                if tool in ('Write', 'Edit', 'MultiEdit'):
                    fp = entry.get('input', {}).get('file_path', '')
                    if fp.endswith('.ts') or fp.endswith('.tsx'):
                        touched.append(fp)
    print('\n'.join(touched) if touched else '')
except Exception as e:
    print('unknown')
" "$TRANSCRIPT" 2>/dev/null)

if [[ -z "$TS_TOUCHED" ]]; then
  echo "$TS [stop-verify] no .ts files touched — skipping typecheck" >> "$LOG"

  python3 -c "print(__import__('json').dumps({'systemMessage': '✓ Turn complete (no TS changes)'}))"
  exit 0
fi

if [[ "$TS_TOUCHED" == "unknown" ]]; then
  echo "$TS [stop-verify] could not read transcript — running full typecheck" >> "$LOG"
fi

# Run typecheck
ERRORS=$(pnpm typecheck 2>&1 | grep "error TS" | head -10)

if [[ -n "$ERRORS" ]]; then
  COUNT=$(echo "$ERRORS" | wc -l | tr -d ' ')
  echo "$TS [stop-verify] TYPECHECK FAILED: $COUNT error(s)" >> "$LOG"
  echo "$TS   $(echo "$ERRORS" | head -3)" >> "$LOG"

  # systemMessage shows to user; exit 2 blocks Claude from finishing
  python3 -c "
import json, sys
errors = sys.argv[1]
count = sys.argv[2]
print(json.dumps({
    'systemMessage': f'⛔ {count} TypeScript error(s) — turn blocked until fixed'
}))
" "$ERRORS" "$COUNT"

  echo "TypeScript errors — fix before stopping:" >&2
  echo "$ERRORS" >&2
  exit 2
fi

echo "$TS [stop-verify] typecheck OK" >> "$LOG"
python3 -c "print(__import__('json').dumps({'systemMessage': '✓ Typecheck passed'}))"
exit 0
