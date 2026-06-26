// cost/runaway cap; streaming means no single-read timeout applies; max_tokens still required by every API
export const MAX_OUTPUT_TOKENS = 32_000;

// guards truly stalled connections; SDK default is 10 min, streaming keeps normal turns well clear
export const REQUEST_TIMEOUT_MS = 120_000;

export const MAX_RETRIES = 2;

// seeds the global Config row; loop reads effective values from config, not these constants
export const DEFAULT_HARD_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

// Circuit breaker default: 5 executed/failed writes to the same service+action
// within 10 minutes before further writes are refused.
export const DEFAULT_REMEDIATION_BREAKER_LIMIT = 5;
export const DEFAULT_REMEDIATION_BREAKER_WINDOW_MS = 10 * 60_000;
