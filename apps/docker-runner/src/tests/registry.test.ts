import { describe, expect, it } from "vitest";
import { createDispatchRegistry } from "../commands/registry.js";

describe("createDispatchRegistry", () => {
  const registry = createDispatchRegistry();

  it("serves every Docker and host command", () => {
    for (const name of [
      "ListDockerServices",
      "GetDockerLogs",
      "GetDockerConfig",
      "GetDockerStats",
      "GetDockerEvents",
      "GetDockerProcesses",
      "RestartDockerService",
      "DockerBash",
      "GetHostMemory",
      "GetHostCPU",
      "GetHostDisk",
      "GetHostNetwork",
      "GetHostDmesg",
      "ReadHostFile",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  // The binary is the declaration: there is no Kubernetes handler to reach, so a
  // misrouted command dies at lookup rather than at a runtime identity guard.
  it("has no Kubernetes handler to misroute to", () => {
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
      expect(registry.has(name)).toBe(false);
    }
  });

  it("refuses a command input that is not shaped like its schema", async () => {
    const logs = registry.get("GetDockerLogs")!;
    await expect(logs({ service: { project: "app" } })).rejects.toThrow(
      /"service"/,
    );
    await expect(logs({})).rejects.toThrow(/"service"/);
  });
});
