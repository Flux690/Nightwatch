import path from "node:path";
import fs from "node:fs";

// Which host paths a file read may reach. Docker only: a Kubernetes runner is one
// pod on one arbitrary node, so its filesystem answers no question worth asking.
const DEFAULT_ALLOWLIST = [
  "/etc/nginx",
  "/etc/app",
  "/var/log",
  "/proc/meminfo",
  "/proc/stat",
  "/proc/loadavg",
];

export function isPathAllowed(filePath: string): boolean {
  const allowlist = buildAllowlist();
  const normalized = path.resolve(filePath);

  let resolved: string;
  let pathExists: boolean;
  try {
    resolved = fs.realpathSync(normalized);
    pathExists = true;
  } catch {
    resolved = normalized;
    pathExists = false;
  }

  return allowlist.some((allowed) => {
    const normalizedAllowed = path.resolve(allowed);
    let effectiveAllowed = normalizedAllowed;
    if (pathExists) {
      // allowlist entry may itself be a symlink (e.g. /var/log on macOS); resolve
      // both sides into the same namespace so the comparison is correct.
      try {
        effectiveAllowed = fs.realpathSync(normalizedAllowed);
      } catch {
        effectiveAllowed = normalizedAllowed;
      }
    }
    // "+" prevents /etc/app-secrets from matching the /etc/app allowlist entry.
    return (
      resolved === effectiveAllowed ||
      resolved.startsWith(effectiveAllowed + "/")
    );
  });
}

function buildAllowlist(): string[] {
  const env = process.env["FILE_ALLOWLIST"];
  return env
    ? [...DEFAULT_ALLOWLIST, ...env.split(":").filter(Boolean)]
    : DEFAULT_ALLOWLIST;
}

// Open-then-validate, closing the check/open TOCTOU: open the fd once (pinned to the resolved inode), then
// prove that inode is reachable via an allowlisted canonical path. Reads come from the handle, never the name; O_NONBLOCK stops a planted FIFO hanging open.
export async function openAllowedFile(
  requestedPath: string,
): Promise<fs.promises.FileHandle> {
  const handle = await fs.promises.open(
    requestedPath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    const fdStat = await handle.stat({ bigint: true });
    if (!fdStat.isFile()) {
      throw new Error(`Not a regular file: ${requestedPath}`);
    }
    const canonical = await fs.promises.realpath(requestedPath);
    if (!isPathAllowed(canonical)) {
      throw new Error(
        `Path not in allowlist: ${requestedPath}. Add to FILE_ALLOWLIST env var to enable.`,
      );
    }
    // Bind the allowlisted name to the opened inode: if a symlink was swapped between open and realpath,
    // the canonical name now resolves to a different inode than the fd holds, so we refuse rather than read the wrong file.
    const nameStat = await fs.promises.stat(canonical, { bigint: true });
    if (nameStat.ino !== fdStat.ino || nameStat.dev !== fdStat.dev) {
      throw new Error(
        `Path changed during open (possible symlink swap): ${requestedPath}`,
      );
    }
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}
