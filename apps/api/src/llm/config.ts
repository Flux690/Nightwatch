// Stands in only for models whose catalog publishes no ceiling of their own.
export const MAX_OUTPUT_TOKENS = 32_000;

// guards truly stalled connections; SDK default is 10 min, streaming keeps normal turns well clear
export const REQUEST_TIMEOUT_MS = 120_000;

// Retries live in one place: withLLMRetries. The SDKs' own retries are switched
// off so a single logical call cannot quietly become a dozen HTTP attempts.
export const MAX_RETRIES = 3;

// Exponential from 5s, so the default 3 retries ride out ~65s of provider blip.
export function retryDelaysMs(retries: number): number[] {
  return Array.from({ length: Math.max(0, retries) }, (_, i) => 5_000 * 3 ** i);
}

// seeds the global Config row; loop reads effective values from config, not these constants

// How many investigations may be in flight at once, counting the suspended ones:
// a run waiting on an approval still holds its seat, because freeing it starts
// another run whose write needs the same person.
export const DEFAULT_MAX_CONCURRENT_INVESTIGATIONS = 10;

// How long the agent works before finishing its current step and asking whether
// to continue. Not a kill switch: the continue gate is what it reaches.
export const DEFAULT_CHECK_IN_AFTER_MS = 30 * 60_000;

// Upper bound on any single tool call. Individual tools declare their own, often
// far lower; this is the user's brake on the slowest of them.
export const DEFAULT_TOOL_CALL_CEILING_MS = 10 * 60_000;

// For a tool that declares no limit of its own. A property of the tool, not a
// preference, so it stays a constant rather than a setting.
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

// The ceiling on one tool result, counted in the characters the model reads.
// Claude Code's Bash tool and OpenHands' runtime arrived at the same figure.
export const MAX_TOOL_RESULT_CHARS = 30_000;

// Circuit breaker default: 5 executed/failed writes to the same service+action
// within 10 minutes before further writes are refused.

export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_SANDBOX_CPUS = 2;
export const DEFAULT_SANDBOX_MEMORY_MB = 4096;

// gVisor is used automatically when the host advertises it; this flag only
// controls whether its absence is a hard failure. Off by default.
export const DEFAULT_SANDBOX_REQUIRE_GVISOR = false;

// Allowlist by default: sandbox egress is forced through the shared proxy,
// which reaches only these hosts - the agent installs dependencies itself.
export const DEFAULT_SANDBOX_NETWORK = "allowlist" as const;
export const DEFAULT_SANDBOX_ALLOWLIST_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
];
