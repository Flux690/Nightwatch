#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))
" 2>/dev/null)

PROTECTED=(
  ".env"
  ".env.local"
  ".env.production"
  "pnpm-lock.yaml"
)

for protected in "${PROTECTED[@]}"; do
  if [[ "$FILE" == *"$protected"* ]]; then
    echo "BLOCKED: $protected is a protected file." >&2
    echo "Edit it manually if needed." >&2
    exit 2
  fi
done

exit 0
