// Shared tuning for every LLM provider. Kept in one module so the providers
// don't drift apart on values that should be identical.

// Output ceiling for every provider. Requests stream (see the providers), so
// this is no longer bounded by the single-read HTTP timeout - it is purely a
// cost/runaway cap and headroom for a large `conclude` result. The API still
// requires max_tokens on every request; the model stops earlier on its own.
export const MAX_OUTPUT_TOKENS = 32_000;

// Bound each request so a hung connection can't block the loop budget; the SDK
// default is 10 minutes. Streaming keeps the connection active, so a normal
// turn never approaches this - it only guards a truly stalled request.
export const REQUEST_TIMEOUT_MS = 120_000;

export const MAX_RETRIES = 2;

// Investigation-loop budget defaults. These seed the global Config row and are
// the fallback when no row exists; the loop reads the effective values from
// config, not these constants directly.
export const DEFAULT_MAX_TOOL_CALLS = 24;
export const DEFAULT_HARD_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
