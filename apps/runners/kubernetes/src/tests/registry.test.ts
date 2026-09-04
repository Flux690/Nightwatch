import { describe, expect, it } from "vitest";
import { DOCKER_TOOL_NAMES, KUBERNETES_TOOL_NAMES } from "@nightwarden/shared";
import { createDispatchRegistry } from "../commands/registry.js";

describe("createDispatchRegistry", () => {
  const registry = createDispatchRegistry();

  // Both directions against the shared list: a tool added there with no
  // handler here, and a handler answering to a name the build never declares.
  it("serves every Kubernetes command the build declares, and no other", () => {
    for (const name of KUBERNETES_TOOL_NAMES) {
      expect(registry.has(name), name).toBe(true);
    }
    expect([...registry.keys()].sort()).toEqual(
      [...KUBERNETES_TOOL_NAMES].sort(),
    );
  });

  // The binary is the declaration: no dockerode, no host /proc, and no handler to
  // reach, so a misrouted command dies at lookup rather than at a runtime guard.
  it("has no Docker or host handler to misroute to", () => {
    for (const name of DOCKER_TOOL_NAMES) {
      expect(registry.has(name), name).toBe(false);
    }
  });

  it("refuses a command input that is not shaped like its schema", async () => {
    const logs = registry.get("GetK8sLogs")!;
    await expect(logs({ service: { namespace: "shop" } })).rejects.toThrow(
      /"workload"/,
    );
  });

  // Nothing splits an executable on spaces, so a command line here would name a
  // binary that does not exist; the refusal points at the field it belongs in.
  it("refuses an executable holding arguments and names args instead", async () => {
    const exec = registry.get("K8sExec")!;
    await expect(
      exec({
        service: { namespace: "shop", workload: "api" },
        executable: "redis-cli info memory",
        reason: "read the memory stats",
      }),
    ).rejects.toThrow(/"args"/);
  });
});
