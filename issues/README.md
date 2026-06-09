# Issues

Local-markdown issue tracker. Vertical-slice (tracer-bullet) work tickets that
each cut through every layer end-to-end. This replaces the old horizontal phase
plan: "what's next" is the open issue backlog, not a layer-by-layer plan.

## Layout

```
issues/
  <feature>/prd.md        per-feature PRD (ephemeral; from /to-prd)
  NNN-short-title.md       open issue
  done/NNN-short-title.md  archived once shipped (never deleted)
```

`NNN` is a zero-padded sequential number. Create blocker issues first so
cross-references use real filenames.

## Issue frontmatter (our "labels")

Labels are frontmatter fields, since issues are local markdown:

```markdown
---
mode: afk | hitl            # afk = agent-implementable; hitl = needs human judgment
type: bugfix | infra | feature | refactor | polish
priority: p1 | p2 | p3      # p1 highest
status: ready-for-agent | in-progress | blocked
blocked_by: [002-...]       # filenames, or [] / omit if none
---
```

## Task-selection order (for AFK picks)

Mirrors the tracer-bullet methodology:

1. `type: bugfix priority: p1` — critical bugfixes
2. `type: infra` — tests, types, dev scripts (preconditions for quality work)
3. `type: feature` — tracer bullets for new features
4. `type: polish` — quick wins
5. `type: refactor`

## Body template

```markdown
## Parent PRD
`issues/<feature>/prd.md`

## What to build
A thin vertical slice through all layers. Describe end-to-end behavior, not
layer-by-layer implementation.

## Acceptance criteria
- [ ] ...

## Test boundary
Which seam this is tested through (prefer existing, highest seam).

## User stories addressed
- ...
```
