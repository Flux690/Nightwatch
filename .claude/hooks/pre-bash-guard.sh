#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('tool_input',{}).get('command',''))
" 2>/dev/null)

BLOCKED_PATTERNS=(
  "rm -rf /"
  "rm -rf \*"
  "git push --force.*main"
  "git push --force.*v2"
  "git push -f.*main"
  "git push -f.*v2"
  "git commit --no-verify"
  "DROP TABLE"
  "TRUNCATE"
  "pkill"
  "killall"
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$CMD" | grep -qiE "$pattern"; then
    echo "BLOCKED: matches protected pattern '$pattern'" >&2
    echo "If you genuinely need this, run it yourself in the terminal." >&2
    exit 2
  fi
done

exit 0
