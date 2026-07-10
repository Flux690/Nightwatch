import { execFile } from "node:child_process";
import {
  detectIsolation,
  ensureImage,
  pingDocker,
  type Isolation,
} from "./docker.js";

export interface PreflightResult {
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

// Runs when the operator clicks Connect: fail loud at setup time, never at
// 3am mid-incident. The image pull is kicked off in the background so the
// first real code session doesn't pay it either.
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
