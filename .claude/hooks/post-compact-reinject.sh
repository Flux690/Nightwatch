#!/bin/bash
python3 -c "
import json
output = {
  'hookSpecificOutput': {
    'additionalContext': '''Context was compacted. Key constraints still apply:
- All shared types belong in packages/shared only — never duplicated
- Every WebSocket command needs a matching type in shared/ws.ts
- No any in TypeScript. No console.log in source files
- Never edit .env files
- Commit after each completed task before starting the next
- Run pnpm typecheck before declaring any task complete'''
  }
}
print(json.dumps(output))
"
