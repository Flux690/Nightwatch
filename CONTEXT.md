# Context — Nightwatch Domain Language

The shared vocabulary for Nightwatch. Use these terms consistently in code,
issues, and commits. This file is seeded from established terms and is extended
during `/grill-with-docs` sessions as decisions crystallise.

## Core nouns

- **Runner** — the agent installed on a customer host. The "hands": executes
  read/remediation commands, holds the SQLite system-of-record (incidents,
  sessions, transcripts). Side-effect-free reads; writes only via remediation.
- **API / brain** — the central service that reasons. The only place an LLM is
  instantiated (`createProvider`). Talks to runners exclusively via `sendCommand`.
- **Console** — the operator UI.
- **Installation** — a registered runner, identified by its token.
- **Session** — a durable, resumable agentic thread. Owns its own id. Started by
  one of two **triggers**: `alert` (an alert authors the opening message) or
  `chat` (a human authors it). The unit of work the loop runs over.
- **Incident** — an optional child artifact of a session: the structured finding
  emitted by `conclude`. Not every session produces one.
- **Transcript** — the persisted `session_messages` for a session, enough to
  rebuild valid provider turns on resume.

## Core verbs / flows

- **Trigger** — what starts a session (`alert` | `chat`).
- **Relay** — the API forwarding a read-only `DashboardQuery` to a runner
  (cached), never reading runner data independently.
- **Approval gate** — `REQUIRES_APPROVAL`: remediation tools that need human
  approve/reject before execution.
- **Conclude** — emits the structured finding and ends a *run*; never closes a
  *session* (a session stays resumable).
- **Escalate** — the critical-severity path.

## Workflow terms

- **Vertical slice / tracer bullet** — an issue that cuts through all layers
  end-to-end and is demoable on its own. The opposite of a horizontal,
  layer-by-layer phase.
- **HITL / AFK** — Human-In-The-Loop (needs human judgment) vs Away-From-Keyboard
  (agent-implementable).
- **Deep module** — small stable interface hiding complex implementation; the
  preferred shape (one test boundary at the public seam).
