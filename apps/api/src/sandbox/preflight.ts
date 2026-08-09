import { execFile } from "node:child_process";
import {
  detectIsolation,
  ensureImage,
  pingDocker,
  type Isolation,
} from "./docker.js";

interface PreflightResult {
  ok: boolean;
  reason?: string;
  // Which isolation the host will actually use for sandboxes, so the console
  // can show it plainly rather than leaving it silent.
  isolation?: Isolation;
}

function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], (error) => resolve(error === null));
  });
}

// Fail loud at setup time, never at 3am mid-incident; the image pull runs in
// the background so the first real session doesn't pay it.
export async function preflight(): Promise<PreflightResult> {
  if (!(await gitAvailable())) {
    return { ok: false, reason: "git is not installed on the API host" };
  }
  try {
    await pingDocker();
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? err.message
          : "Docker daemon is not reachable on the API host",
    };
  }
  const isolation = await detectIsolation();
  void ensureImage().catch(() => undefined);
  return { ok: true, isolation };
}
