# Testing Rules

- Test files live in `src/tests/` within each app. Never use `__tests__` (no double-underscore directories anywhere).
- One test file per source module or component. The split boundary is the unit under test, not line count.
- Use `describe` blocks to organize related tests within a file. Do not split a single component's tests into multiple files.
- Test file names mirror the source file, **including case**: `dispatcher.ts` →
  `dispatcher.test.ts`, `Sessions.tsx` → `Sessions.test.tsx`. The case follows the
  source (kebab-case source → kebab-case test); do not rename to camelCase. An
  integration test that spans several modules has no single source to mirror, so
  name it for the behaviour it exercises (e.g. `approval-cycle.test.ts`).
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
