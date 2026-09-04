import { describe, expect, it } from "vitest";
import { DOCKER_TOOL_NAMES, KUBERNETES_TOOL_NAMES } from "@nightwarden/shared";
import { createDispatchRegistry } from "../commands/registry.js";

describe("createDispatchRegistry", () => {
  const registry = createDispatchRegistry();

  // Both directions against the shared list: a tool added there with no
  // handler here, and a handler answering to a name the build never declares.
  it("serves every Docker and host command the build declares, and no other", () => {
    for (const name of DOCKER_TOOL_NAMES) {
      expect(registry.has(name), name).toBe(true);
    }
    expect([...registry.keys()].sort()).toEqual([...DOCKER_TOOL_NAMES].sort());
  });

  // The binary is the declaration: there is no Kubernetes handler to reach, so a
  // misrouted command dies at lookup rather than at a runtime identity guard.
  it("has no Kubernetes handler to misroute to", () => {
    for (const name of KUBERNETES_TOOL_NAMES) {
      expect(registry.has(name), name).toBe(false);
    }
  });

  it("refuses a command input that is not shaped like its schema", async () => {
    const logs = registry.get("GetDockerLogs")!;
    // Path-qualified, so a nested miss says which field of which object.
    await expect(logs({ service: { project: "app" } })).rejects.toThrow(
      /"service\.service"/,
    );
    await expect(logs({})).rejects.toThrow(/"service"/);
  });

  // Nothing splits an executable on spaces, so a command line here would name a
  // binary that does not exist; the refusal points at the field it belongs in.
  it("refuses an executable holding arguments and names args instead", async () => {
    const exec = registry.get("DockerExec")!;
    await expect(
      exec({
        service: { project: "shop", service: "api" },
        executable: "redis-cli info memory",
        reason: "read the memory stats",
      }),
    ).rejects.toThrow(/"args"/);
  });
});
