import { detectToolchain, readPackageJson } from "./install.js";
import type { Workspace } from "./workspace.js";

export interface VerificationResult {
  ran: boolean;
  command?: string;
  passed?: boolean;
  output?: string;
  // Honest absence: why verification could not run (surfaced verbatim in the
  // PR body), as distinct from "no script detected".
  reason?: string;
}

const SCRIPT_PRIORITY = ["test", "typecheck", "build"] as const;

// package.json scripts tried in test -> typecheck -> build priority; no
// detectable verification is reported honestly, never invented.
export async function runVerification(
  ws: Workspace,
  timeoutMs: number,
): Promise<VerificationResult> {
  if (ws.setup !== null && ws.setup.exitCode !== 0) {
    return {
      ran: false,
      reason: `dependency install failed during sandbox setup (\`${ws.setup.command}\` exited ${ws.setup.exitCode})`,
    };
  }

  const pkg = await readPackageJson(ws.dir);
  if (pkg === null) return { ran: false };

  const scripts =
    typeof pkg["scripts"] === "object" && pkg["scripts"] !== null
      ? (pkg["scripts"] as Record<string, unknown>)
      : {};
  const script = SCRIPT_PRIORITY.find(
    (name) => typeof scripts[name] === "string",
  );
  if (script === undefined) return { ran: false };

  const { rule } = await detectToolchain(ws.dir, pkg);
  const command = `${rule.runPrefix} run ${script}`;
  const result = await ws.exec(command, { timeoutMs });
  return {
    ran: true,
    command,
    passed: result.exitCode === 0,
    output: result.output,
  };
}
