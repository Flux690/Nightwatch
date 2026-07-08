import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

export type PackageManager = "pnpm" | "yarn" | "npm";

export interface VerificationResult {
  ran: boolean;
  command?: string;
  passed?: boolean;
  output?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// The packageManager field (corepack convention) is authoritative; otherwise
// the committed lockfile is the evidence - it is package-manager-specific by
// construction. Multiple lockfiles resolve pnpm -> yarn -> npm; none means npm.
export async function detectPackageManager(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<PackageManager> {
  const declared = pkg["packageManager"];
  if (typeof declared === "string") {
    if (declared.startsWith("pnpm")) return "pnpm";
    if (declared.startsWith("yarn")) return "yarn";
    if (declared.startsWith("npm")) return "npm";
  }
  if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

const SCRIPT_PRIORITY = ["test", "typecheck", "build"] as const;

// v1 is Node-first by design: package.json scripts in test -> typecheck ->
// build priority. No detectable verification is reported honestly, never
// invented - the PR body states it plainly.
export async function runVerification(
  ws: Workspace,
  timeoutMs: number,
): Promise<VerificationResult> {
  let pkg: Record<string, unknown>;
  try {
    // Parsed shape is narrowed field-by-field below.
    pkg = JSON.parse(
      await readFile(join(ws.dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return { ran: false };
  }

  const scripts =
    typeof pkg["scripts"] === "object" && pkg["scripts"] !== null
      ? (pkg["scripts"] as Record<string, unknown>)
      : {};
  const script = SCRIPT_PRIORITY.find(
    (name) => typeof scripts[name] === "string",
  );
  if (script === undefined) return { ran: false };

  const pm = await detectPackageManager(ws.dir, pkg);
  const command = `${pm} run ${script}`;
  const result = await ws.exec(command, { timeoutMs });
  return {
    ran: true,
    command,
    passed: result.exitCode === 0,
    output: result.output,
  };
}
