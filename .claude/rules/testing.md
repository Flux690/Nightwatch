# Testing Rules

- Test files live in `src/tests/` within each app. Never use `__tests__` (no double-underscore directories anywhere).
- **Organize tests around behavioural seams, not source modules.** A seam is the
  highest public boundary that exercises the behaviour: an HTTP route, the
  runner/console WebSocket protocol, a subsystem's public function, a component's
  rendered behaviour. One behaviour usually spans several modules and gets *one*
  seam test - the seam is the split boundary, not the file count or the module
  graph. (e.g. `approval-cycle.test.ts` drives loop + gate + human-input + db
  together; `kubernetes-runner.test.ts` drives resolve + commands through the
  command dispatch.)
- **A module reached only through a seam does not get its own test file** - it is
  covered by the seam test that exercises it. The transcript card panels are
  tested through `TranscriptItemRenderer`; the approval executor through the
  respond route; the command transport through the WS protocol. Add a dedicated
  test only when a module has a public contract worth pinning on its own (e.g.
  `service-identity` key building, the allowlist redaction corpus).
- Name a test for the seam/behaviour it exercises. When a test *is* a single
  module's seam, mirror that file's name including case (`dispatcher.ts` →
  `dispatcher.test.ts`, `Sessions.tsx` → `Sessions.test.tsx`); kebab-case source →
  kebab-case test, never renamed to camelCase.
- Use `describe` blocks to organize related cases within a file. Do not split one
  seam's tests across multiple files.
- Mock only at system boundaries: external HTTP, WebSocket, time, randomness. Never mock our own modules.
- A boundary test double must honour the real contract it stands in for. For the
  LLM boundary use the shared `contract-fake-provider` (it validates transcript
  shape and restores `seed` faithfully); never hand-roll a per-file provider fake -
  an unfaithful stub (e.g. a no-op `seed`) silently corrupts a resumed run.
- A dispatched/background run that fails must surface as a test failure, never be
  swallowed. The dispatcher catches and logs `investigation failed` (correct for
  production); the shared `tests/setup.ts` turns that log into a failed test.
- Use `vi.stubGlobal` / `vi.unstubAllGlobals` (not manual assignment) so stubs are cleaned up automatically.
- Always wrap state-mutating actions in `act()`; always use `waitFor` for async assertions.
- Query by role or visible text first (`getByRole`, `getByText`). Fall back to `data-testid` only when no semantic query applies.
