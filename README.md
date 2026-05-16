# Nightwatch

Nightwatch is an autonomous SRE agent that monitors Docker containers, detects infrastructure incidents from logs, and automatically remediates them using Gemini as the reasoning engine. It runs as a continuous control loop — observing logs, identifying incidents, planning Docker command sequences, and executing fixes with your approval.

## Prerequisites

- Node.js 18+
- Docker daemon running
- Gemini API key

## Setup

1. Clone the repo and install dependencies:

```bash
npm install
```

2. Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_key_here
```

3. Have a `docker-compose.yaml` for the infrastructure you want to monitor, and make sure its containers are running:

```bash
docker compose up -d
```

## Running Nightwatch

**Development (without building):**

```bash
npm run dev -- --compose path/to/docker-compose.yaml
```

Note the `--` before flags — npm requires this to forward arguments to the underlying script. If you're running against the included Clipper stack, there's a shortcut:

```bash
npm run dev:clipper
```

**Production (build first, then run):**

```bash
npm run build
node dist/index.js --compose path/to/docker-compose.yaml
```

Or install globally and use the `nightwatch` binary directly:

```bash
npm install -g .
nightwatch --compose path/to/docker-compose.yaml
```

### CLI Options

```bash
nightwatch                                        # Auto-discover compose files in current directory
nightwatch --compose docker-compose.yaml          # Point to a specific file
nightwatch --compose db.yml,api.yml,cache.yml     # Multiple files (comma-separated)
nightwatch --compose ./services/                  # Auto-discover in a subdirectory
nightwatch --mode observe                         # Diagnose only, no changes made
nightwatch --mode remediate                       # Full remediation (default)
nightwatch --max-retries 5                        # Max replan attempts before escalating (default: 3)
```

**Example:**

```bash
nightwatch --compose ./clipper/docker-compose.yaml --mode remediate --max-retries 3
```

## Modes

### `remediate` (default)
Full autonomous operation. Nightwatch detects incidents, plans a remediation, asks for your approval, executes it, and verifies the fix.

### `observe`
Diagnostic only. Nightwatch analyzes incidents and reports its findings but makes no changes to your infrastructure.

## How It Works

Nightwatch runs a continuous loop over your container logs. When it detects error patterns it triggers an incident investigation. Gemini acts as the orchestrator, selecting which capability to invoke at each step:

```
Logs → analyzeIncident → assessFeasibility → planRemediation → validatePlan → executePlan → verifyPlan → resolved
```

Each stage is a specialized LLM agent with access to Docker inspection tools. Stages share conversation history so later agents have full context from earlier investigation. Tool results are cached per incident to avoid redundant Docker API calls.

When Nightwatch needs input from you — to approve a plan, answer a missing-context question, or decide on escalation — it pauses and presents an interactive prompt.

## Capabilities

| Capability | What it does |
|---|---|
| `analyzeIncident` | Reads logs and Docker state to build an incident graph of affected components |
| `assessFeasibility` | Determines whether safe automated remediation is possible |
| `planRemediation` | Generates a sequence of Docker commands to fix the incident |
| `validatePlan` | Checks commands against safety rules before execution |
| `executePlan` | Runs the plan sequentially, stops on first failure |
| `verifyPlan` | Confirms the fix worked by re-inspecting container state |
| `consultUser` | Asks for plan approval, missing context, or escalation decisions |
| `reportFindings` | Produces a diagnostic summary (observe mode only) |

## Safety

All commands are validated before execution:

- Only `docker` CLI commands are allowed
- Shell operators (`|`, `>`, `;`, `&&`) and command substitution are blocked
- Each command must target exactly one known container
- Destructive patterns (`rm -rf`, `dd if=`) are blocked

## Knowledge Persistence

When Nightwatch asks you a question and you answer it, that fact is saved to `.nightwatch/knowledge.md` relative to your compose file location. On the next incident, it consults this file before asking you the same question again.

## Project Structure

```
src/
├── index.ts                  # CLI entry point
├── config.ts                 # Runtime config type
├── globals.ts                # Singleton context store
├── capabilities/             # analyzeIncident, assessFeasibility, planRemediation, ...
├── orchestration/
│   ├── workflow.ts           # Main control loop
│   ├── registry.ts           # Capability declarations exposed to Gemini
│   ├── composeLoader.ts      # Compose file discovery and parsing
│   ├── resolvedStore.ts      # Incident deduplication (5-min TTL)
│   └── prompt.md             # Orchestrator system prompt
├── llm/
│   ├── runtime.ts            # Agent loop with tool calling
│   ├── model.ts              # Gemini SDK setup
│   └── knowledge.ts          # Knowledge file read/write
├── tools/
│   ├── docker.ts             # list, inspect, stats, logs, top
│   └── cache.ts              # Per-incident tool result cache
├── execution/
│   ├── validator.ts          # Command safety validation
│   └── executor.ts           # Sequential command runner
├── observation/
│   ├── logBuffer.ts          # Error pattern detection and batching
│   └── observeContainerLogs.ts
└── utils/
    ├── formInput.ts          # Interactive TUI (approval, escalation, context prompts)
    └── colors.ts / logger.ts / helpers.ts
```
