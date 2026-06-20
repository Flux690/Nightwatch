# Workflow Rules

We work in **vertical slices with TDD**, not horizontally (layer by layer).
Every issue cuts through all layers and is demoable/verifiable on its own.

## Issue tracker config (read by /to-prd and /to-issues)

- **Tracker:** local markdown in `issues/` (see `issues/README.md`). Do NOT use
  GitHub issues or Linear. Publishing an issue = writing `issues/NNN-title.md`.
- **Per-feature PRD:** `.claude/<feature>-prd.md` (flat, in .claude/).
- **Labels:** frontmatter fields - `mode` (afk|hitl), `type`
  (bugfix|infra|feature|refactor|polish), `priority` (p1|p2|p3), `status`
  (ready-for-agent|in-progress|blocked), `blocked_by`. The `ready-for-agent`
  marker is `status: ready-for-agent`.
- **Single enduring reference:** `README.md` (project, architecture). Not a per-feature PRD - per-feature PRDs link to it. There is no separate PRD.md or docs/adr/.

## The cycle

```
pick feature (HITL) -> /grill-with-docs (HITL) -> /to-prd -> /to-issues (HITL)
  -> per issue: /tdd (fresh context) -> /qa + review (HITL) -> ship
```

- Alignment is front-loaded into the grill. If implementation needs many
  questions, the grill was too shallow.
- One issue per session. Clear context between issues - never compact. All
  durable knowledge lives in README.md, the issue file, and rich commit
  messages.
- Infra before features (tests/types first); they are the feedback-loop ceiling.

## Feedback loops (must pass before every commit)

- `pnpm typecheck`
- `pnpm test`

## TDD

Vertical red-green-refactor: one failing test -> minimal code to pass -> repeat.
Test observable behavior through the highest public seam, never implementation
details. Mock only at system boundaries (external APIs, time, randomness); never
mock our own modules - if you want to, deepen the module instead.
