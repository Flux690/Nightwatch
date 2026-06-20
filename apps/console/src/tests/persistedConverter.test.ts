import { describe, it, expect } from "vitest";
import type { SessionMessage } from "@nightwatch/shared";

import { convertPersistedMessages } from "../transcript/persistedConverter.js";
import type { ThinkingItem } from "../transcript/types.js";

function assistantMessage(
  seq: number,
  providerContent: unknown,
): SessionMessage {
  return {
    id: `m${seq}`,
    sessionId: "s1",
    seq,
    role: "assistant",
    content: "",
    providerContent,
    createdAt: new Date().toISOString(),
  } as unknown as SessionMessage;
}

describe("convertPersistedMessages — thinking", () => {
  it("extracts a thinking block as a collapsed, non-streaming item", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "thinking", thinking: "Checking the logs first" },
        { type: "text", text: "Looks fine." },
      ]),
    ]);

    expect(items).toHaveLength(2);
    const thinking = items[0] as ThinkingItem;
    expect(thinking.kind).toBe("thinking");
    expect(thinking.text).toBe("Checking the logs first");
    expect(thinking.streaming).toBe(false);
    expect(thinking.collapsed).toBe(true);
    expect(items[1]).toMatchObject({ kind: "agent_text", text: "Looks fine." });
  });

  it("preserves occurrence order across multiple thinking bursts and tool calls", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "thinking", thinking: "First, check the container" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "check_service_status",
          input: {},
        },
      ]),
      assistantMessage(2, [
        { type: "thinking", thinking: "Now decide on a fix" },
        { type: "text", text: "Restarting should fix it." },
      ]),
    ]);

    expect(items.map((i) => i.kind)).toEqual([
      "thinking",
      "tool_card",
      "thinking",
      "agent_text",
    ]);
    expect((items[0] as ThinkingItem).text).toBe("First, check the container");
    expect((items[2] as ThinkingItem).text).toBe("Now decide on a fix");
  });

  it("produces no thinking items when providerContent has no thinking blocks", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [{ type: "text", text: "All good." }]),
    ]);

    expect(items.some((i) => i.kind === "thinking")).toBe(false);
  });

  it("assigns each thinking block a stable, unique id", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "thinking", thinking: "burst one" },
        { type: "thinking", thinking: "burst two" },
      ]),
    ]);

    const ids = items.map((i) => (i as ThinkingItem).id);
    expect(new Set(ids).size).toBe(2);
  });
});
