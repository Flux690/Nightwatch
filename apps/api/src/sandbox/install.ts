import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

interface InstallPlan {
  command: string;
}

function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function pinnedManager(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const field = (parsed as Record<string, unknown>)["packageManager"];
    return typeof field === "string" ? field : null;
  } catch {
    // Missing or malformed package.json reads as unpinned, never as a failure.
    return null;
  }
}

// A pinned pnpm or yarn goes through corepack for that exact version. Unpinned
// repos use the image's binaries, except yarn, which stays on corepack.
export async function resolveInstallPlan(
  dir: string,
): Promise<InstallPlan | null> {
  const pinned = await pinnedManager(dir);
  if (pinned !== null) {
    const name = pinned.split("@")[0];
    if (name === "pnpm" || name === "yarn") {
      return { command: `corepack ${name} install` };
    }
    if (name === "npm") return { command: "npm install" };
  }
  if (await fileExists(join(dir, "pnpm-lock.yaml"))) {
    return { command: "pnpm install" };
  }
  if (await fileExists(join(dir, "yarn.lock"))) {
    return { command: "corepack yarn install" };
  }
  if (await fileExists(join(dir, "package-lock.json"))) {
    return { command: "npm install" };
  }
  return null;
}
