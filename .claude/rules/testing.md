# Testing Rules

- Test files live in `src/tests/` within each app. Never use `__tests__` (no double-underscore directories anywhere).
- One test file per source module or component. The split boundary is the unit under test, not line count.
- Use `describe` blocks to organize related tests within a file. Do not split a single component's tests into multiple files.
- Test file names mirror the source file: `Sessions.tsx` → `tests/Sessions.test.tsx`.
- Mock only at system boundaries: external HTTP, WebSocket, time, randomness. Never mock our own modules.
- Use `vi.stubGlobal` / `vi.unstubAllGlobals` (not manual assignment) so stubs are cleaned up automatically.
- Always wrap state-mutating actions in `act()`; always use `waitFor` for async assertions.
- Query by role or visible text first (`getByRole`, `getByText`). Fall back to `data-testid` only when no semantic query applies.
