import { describe, expect, it } from "vitest";
import { createDispatchRegistry } from "../commands/registry.js";

describe("createDispatchRegistry", () => {
  const registry = createDispatchRegistry();

  it("serves every Kubernetes command", () => {
    for (const name of [
      "ListK8sWorkloads",
      "GetK8sLogs",
      "GetK8sConfig",
      "GetK8sStats",
      "GetK8sEvents",
      "GetK8sProcesses",
      "RestartK8sWorkload",
      "K8sBash",
      "GetK8sRolloutStatus",
      "GetK8sNodeStatus",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  // The binary is the declaration: no dockerode, no host /proc, and no handler to
  // reach, so a misrouted command dies at lookup rather than at a runtime guard.
  it("has no Docker or host handler to misroute to", () => {
    for (const name of [
      "ListDockerServices",
      "GetDockerLogs",
      "RestartDockerService",
      "DockerBash",
      "GetHostMemory",
      "GetHostDmesg",
      "ReadHostFile",
    ]) {
      expect(registry.has(name)).toBe(false);
    }
  });

  it("refuses a command input that is not shaped like its schema", async () => {
    const logs = registry.get("GetK8sLogs")!;
    await expect(logs({ service: { namespace: "shop" } })).rejects.toThrow(
      /"workload"/,
    );
  });
});
