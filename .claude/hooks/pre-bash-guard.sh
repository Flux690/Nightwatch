#!/bin/bash
# Fires before every Bash tool call.
# Only logs when a command is BLOCKED — allowed commands are in the transcript.

LOG=".claude/logs/hooks-$(date +%F).log"
TS=$(date '+%Y-%m-%d %H:%M:%S')
INPUT=$(cat)

SID=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('session_id','')[:8])
" 2>/dev/null || echo "--------")

CMD=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('tool_input',{}).get('command',''))
" 2>/dev/null)

SHORT=$(echo "$CMD" | head -c 80)

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
    echo "$TS [$SID] [pre-bash-guard] BLOCKED: $SHORT" >> "$LOG"
    python3 -c "
import json, sys
pattern = sys.argv[1]
print(json.dumps({'systemMessage': f'🛡 Hook blocked command matching \"{pattern}\"'}))
" "$pattern"
    echo "BLOCKED: matches protected pattern '$pattern'" >&2
    echo "Run it yourself in the terminal if you genuinely need it." >&2
    exit 2
  fi
done

exit 0
