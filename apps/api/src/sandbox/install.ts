import { readFile } from "node:fs/promises";
import { join } from "node:path";

// THE dependency-install rulebook: one row per toolchain, tried top to bottom.
// To support a new ecosystem or change a command, edit this table (and the
// matching rows in sandbox-workspace.test.ts) - nothing else.
//
// `frozen` installs exactly what the lockfile records and fails rather than
// re-resolving; `install` is the relaxed rung for when the frozen one fails
// (lockfile out of sync) or no lockfile exists. pnpm and yarn>=2 run through
// corepack because node:24 ships no shims and its read-only rootfs forbids
// `corepack enable`; corepack caches the manager in HOME during setup, so it
// keeps working after the network is disconnected.
export interface InstallRule {
  toolchain: "pnpm" | "yarn-berry" | "yarn-classic" | "npm";
  runPrefix: string;
  lockfile: string;
  frozen: string;
  install: string;
}

export const INSTALL_RULES: readonly InstallRule[] = [
  {
    toolchain: "pnpm",
    runPrefix: "corepack pnpm",
    lockfile: "pnpm-lock.yaml",
    frozen: "corepack pnpm install --frozen-lockfile",
    install: "corepack pnpm install",
  },
  {
    toolchain: "yarn-berry",
    runPrefix: "corepack yarn",
    lockfile: "yarn.lock",
    frozen: "corepack yarn install --immutable",
    install: "corepack yarn install",
  },
  {
    toolchain: "yarn-classic",
    runPrefix: "yarn",
    lockfile: "yarn.lock",
    frozen: "yarn install --frozen-lockfile",
    install: "yarn install",
  },
  {
    toolchain: "npm",
    runPrefix: "npm",
    lockfile: "package-lock.json",
    frozen: "npm ci",
    install: "npm install",
  },
];

export const INSTALL_TIMEOUT_MS = 600_000;

export interface Toolchain {
  rule: InstallRule;
  hasLockfile: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function ruleFor(toolchain: InstallRule["toolchain"]): InstallRule {
  // The table is the source of truth; a missing row is a programming error.
  const rule = INSTALL_RULES.find((r) => r.toolchain === toolchain);
  if (rule === undefined) throw new Error(`no install rule for ${toolchain}`);
  return rule;
}

// The packageManager field (corepack convention) is authoritative; otherwise
// the committed lockfile is the evidence - it is package-manager-specific by
// construction. Multiple lockfiles resolve pnpm -> yarn -> npm; none means npm.
export async function detectToolchain(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<Toolchain> {
  const declared = pkg["packageManager"];
  let toolchain: InstallRule["toolchain"] | null = null;
  if (typeof declared === "string") {
    if (declared.startsWith("pnpm")) toolchain = "pnpm";
    else if (declared.startsWith("yarn")) {
      const major = parseInt(declared.split("@")[1] ?? "", 10);
      toolchain = major >= 2 ? "yarn-berry" : "yarn-classic";
    } else if (declared.startsWith("npm")) toolchain = "npm";
  }
  if (toolchain === null) {
    if (await exists(join(dir, "pnpm-lock.yaml"))) toolchain = "pnpm";
    else if (await exists(join(dir, "yarn.lock"))) toolchain = "yarn-classic";
    else toolchain = "npm";
  }
  const rule = ruleFor(toolchain);
  return { rule, hasLockfile: await exists(join(dir, rule.lockfile)) };
}

export interface SetupResult {
  toolchain: string;
  command: string;
  exitCode: number;
  outputTail: string;
  // True only when the frozen (fully deterministic) rung succeeded; false
  // covers both the relaxed fallback and the no-lockfile best-effort install.
  frozen: boolean;
}

export type InstallExec = (
  command: string,
) => Promise<{ exitCode: number; output: string }>;

function tail(output: string): string {
  return output.slice(-2000).trim();
}

export async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown> | null> {
  try {
    // Parsed shape is narrowed field-by-field by callers.
    return JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The agent-free setup phase: runs while the network is still attached, never
// driven by the model. Returns null when the repo has nothing to install.
export async function runInstall(
  dir: string,
  exec: InstallExec,
): Promise<SetupResult | null> {
  const pkg = await readPackageJson(dir);
  if (pkg === null) return null;
  const { rule, hasLockfile } = await detectToolchain(dir, pkg);
  const ladder = hasLockfile ? [rule.frozen, rule.install] : [rule.install];
  let result: SetupResult | null = null;
  for (const [rung, command] of ladder.entries()) {
    const { exitCode, output } = await exec(command);
    result = {
      toolchain: rule.toolchain,
      command,
      exitCode,
      outputTail: tail(output),
      frozen: hasLockfile && rung === 0 && exitCode === 0,
    };
    if (exitCode === 0) break;
  }
  return result;
}
