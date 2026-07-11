import { readFile } from "node:fs/promises";
import { join } from "node:path";

// pnpm/yarn>=2 route through corepack since node:24 has no shims and a
// read-only rootfs that forbids `corepack enable`; its HOME cache keeps working offline.
export interface InstallRule {
  toolchain: "pnpm" | "yarn-berry" | "yarn-classic" | "npm";
  bin: string;
  lockfile: string;
  // `frozenArgs` fails rather than re-resolving; `installArgs` is the relaxed fallback.
  frozenArgs: string;
  installArgs: string;
}

// pnpm 11 hard-fails unapproved dependency build scripts; the sandbox is the
// isolation boundary, so run them all - npm and yarn already do.
const PNPM_BUILDS_FLAG = "--config.dangerouslyAllowAllBuilds=true";

export const INSTALL_RULES: readonly InstallRule[] = [
  {
    toolchain: "pnpm",
    bin: "corepack pnpm",
    lockfile: "pnpm-lock.yaml",
    frozenArgs: `install --frozen-lockfile ${PNPM_BUILDS_FLAG}`,
    installArgs: `install ${PNPM_BUILDS_FLAG}`,
  },
  {
    toolchain: "yarn-berry",
    bin: "corepack yarn",
    lockfile: "yarn.lock",
    frozenArgs: "install --immutable",
    installArgs: "install",
  },
  {
    toolchain: "yarn-classic",
    bin: "yarn",
    lockfile: "yarn.lock",
    frozenArgs: "install --frozen-lockfile",
    installArgs: "install",
  },
  {
    toolchain: "npm",
    bin: "npm",
    lockfile: "package-lock.json",
    frozenArgs: "ci",
    installArgs: "install",
  },
];

// Without a packageManager pin corepack fetches whatever is "latest" that day;
// pin a known-good pnpm chosen by the repo's own lockfile format instead.
const PNPM_FALLBACK_BY_LOCKFILE: Record<string, string> = {
  "5.4": "7.33.7",
  "6.0": "8.15.9",
  "9.0": "10.34.5",
};
const PNPM_FALLBACK_DEFAULT = "10.34.5";

export const INSTALL_TIMEOUT_MS = 600_000;

export interface Toolchain {
  rule: InstallRule;
  hasLockfile: boolean;
  runPrefix: string;
  frozen: string;
  install: string;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await readFileOrNull(path)) !== null;
}

function ruleFor(toolchain: InstallRule["toolchain"]): InstallRule {
  // The table is the source of truth; a missing row is a programming error.
  const rule = INSTALL_RULES.find((r) => r.toolchain === toolchain);
  if (rule === undefined) throw new Error(`no install rule for ${toolchain}`);
  return rule;
}

function pnpmFallbackVersion(lockfile: string | null): string {
  const version = lockfile?.match(/^lockfileVersion:\s*['"]?([\d.]+)/m)?.[1];
  if (version === undefined) return PNPM_FALLBACK_DEFAULT;
  const key = version.includes(".") ? version : `${version}.0`;
  return PNPM_FALLBACK_BY_LOCKFILE[key] ?? PNPM_FALLBACK_DEFAULT;
}

// packageManager field wins if declared; otherwise the lockfile is evidence,
// resolved pnpm -> yarn -> npm when several are present.
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
  const declaredPin = toolchain !== null;
  if (toolchain === null) {
    if (await exists(join(dir, "pnpm-lock.yaml"))) toolchain = "pnpm";
    else if (await exists(join(dir, "yarn.lock"))) toolchain = "yarn-classic";
    else toolchain = "npm";
  }
  const rule = ruleFor(toolchain);
  const lockfileContent = await readFileOrNull(join(dir, rule.lockfile));
  const bin =
    toolchain === "pnpm" && !declaredPin
      ? `${rule.bin}@${pnpmFallbackVersion(lockfileContent)}`
      : rule.bin;
  return {
    rule,
    hasLockfile: lockfileContent !== null,
    runPrefix: bin,
    frozen: `${bin} ${rule.frozenArgs}`,
    install: `${bin} ${rule.installArgs}`,
  };
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
  const toolchain = await detectToolchain(dir, pkg);
  const ladder = toolchain.hasLockfile
    ? [toolchain.frozen, toolchain.install]
    : [toolchain.install];
  let result: SetupResult | null = null;
  for (const [rung, command] of ladder.entries()) {
    const { exitCode, output } = await exec(command);
    result = {
      toolchain: toolchain.rule.toolchain,
      command,
      exitCode,
      outputTail: tail(output),
      frozen: toolchain.hasLockfile && rung === 0 && exitCode === 0,
    };
    if (exitCode === 0) break;
  }
  return result;
}
