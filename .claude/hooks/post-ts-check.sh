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

# apps/api/src/sandbox is package-shaped by design: node builtins, external
# packages and ./ siblings only. App imports (db/, session/, @nightwatch/*,
# the logger) would make the eventual extraction surgery instead of a git mv.
if [[ "$FILE" == *"apps/api/src/sandbox/"* ]]; then
  VIOLATIONS=$(python3 -c "
import os, re, sys
path = sys.argv[1]
# Derive the boundary root from the file path itself, not the CWD: the bash
# guard already proved the marker is in the path, so both root and the import
# targets resolve from the same absolute base regardless of where the hook runs.
marker = 'apps/api/src/sandbox'
root = os.path.abspath(path[: path.index(marker) + len(marker)])
src = open(path).read()
bad = set()
for m in re.finditer(r'from\s+[\"\']([^\"\']+)[\"\']', src):
    spec = m.group(1)
    if spec.startswith('node:'):
        continue
    if spec.startswith('.'):
        target = os.path.abspath(os.path.join(os.path.dirname(path), spec))
        if not (target == root or target.startswith(root + os.sep)):
            bad.add(spec)
        continue
    if spec.startswith('@nightwatch/'):
        bad.add(spec)
for spec in sorted(bad):
    print(spec)
" "$FILE" 2>/dev/null)
  if [[ -n "$VIOLATIONS" ]]; then
    echo "$TS [$SID] [post-ts-check] SANDBOX BOUNDARY violation in $SHORT: $VIOLATIONS" >> "$LOG"
    echo "sandbox import-boundary violation in $SHORT — apps/api/src/sandbox may import only node builtins, external packages, and files inside sandbox/. Host specifics enter via WorkspaceOptions callbacks. Forbidden imports found: $VIOLATIONS" >&2
    exit 2
  fi
fi

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
