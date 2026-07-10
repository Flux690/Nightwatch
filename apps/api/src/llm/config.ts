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

// Code sessions: the budget a session extends to on every repo tool call
// (clone + install + tests dwarf the 5-minute investigation default), and the
// sandbox container's lifecycle/resource knobs.
export const DEFAULT_CODE_SESSION_BUDGET_MS = 20 * 60_000;
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_SANDBOX_CPUS = 2;
export const DEFAULT_SANDBOX_MEMORY_MB = 4096;

// gVisor is used automatically when the host advertises it; this flag only
// controls whether its absence is a hard failure. Off by default.
export const DEFAULT_SANDBOX_REQUIRE_GVISOR = false;

// Deny-by-default sandbox egress: only these hosts (and their subdomains) are
// reachable from a code sandbox. The set covers a Node install - package
// registries, Node headers for native modules, and GitHub for git-based deps
// and release binaries. Operators edit the list; the console surfaces blocked
// hosts so a missing one is a one-click add.
export const DEFAULT_SANDBOX_EGRESS_POLICY = "allowlist" as const;
export const DEFAULT_SANDBOX_EGRESS_ALLOWLIST: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "api.github.com",
];
