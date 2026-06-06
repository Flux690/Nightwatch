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
