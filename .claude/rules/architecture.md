# Architecture notes

Current structural facts worth knowing before changing load-bearing code. These
are descriptions, not commandments - revisit any of them on merits when there is a
real reason. The code is the source of truth: if a note here disagrees with the
code, the code wins and the note is what is wrong.

- The API's SQLite file is the system of record. The runner is stateless - its
  only persistent state is its `runner-id` file; it executes commands and keeps no
  durable state of its own. Giving the runner durable state is a real design
  change, not a local tweak.
- Tokens are validated against a stored SHA-256 hash, never appear in logs,
  identifiers, or URLs we control, and every surface that accepts a token (ingest,
  chat, runner WS, console WS) validates it. Runner tokens are hash-only: the
  plaintext is shown once at mint and cannot be recovered. The fleet ingest token
  is the one exception - it is also kept encrypted at rest so the operator can
  reveal it on demand, but only via an explicit POST (`/ingest-credential/reveal`),
  never on the idempotent GET, which returns status only.
- A tool requires human approval purely by its registry `access` value: `write`
  and `ask` suspend the investigation for a human, `read` runs immediately. There
  is no separate approval list - setting `access: "write"` is what gates a tool, so
  the gate cannot be forgotten.
