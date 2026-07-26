import { describe, it, expect } from "vitest";
import type { MessagePart, SessionMessage } from "@nightwarden/shared";

import { convertPersistedMessages } from "@/components/transcript/persistedConverter";
import type { ThinkingItem } from "@/components/transcript/types";

function assistantMessage(seq: number, parts: MessagePart[]): SessionMessage {
  return {
    sessionId: "s1",
    seq,
    role: "assistant",
    content: "",
    parts,
    createdAt: new Date().toISOString(),
  };
}

describe("convertPersistedMessages — error rows", () => {
  it("maps a role 'error' row to an error_text item in order", () => {
    const userRow: SessionMessage = {
      sessionId: "s1",
      seq: 0,
      role: "user",
      content: "hello",
      parts: [{ type: "text", text: "hello" }],
      createdAt: new Date().toISOString(),
    };
    const errorRow: SessionMessage = {
      sessionId: "s1",
      seq: 1,
      role: "error",
      content: "The provider rejected the API key.",
      parts: [],
      createdAt: new Date().toISOString(),
    };

    const items = convertPersistedMessages([userRow, errorRow]);

    expect(items.map((i) => i.kind)).toEqual(["user_turn", "error_text"]);
    expect(items[1]).toMatchObject({
      id: "error-1",
      text: "The provider rejected the API key.",
    });
  });
});

describe("convertPersistedMessages — thinking", () => {
  it("extracts a thinking block as a non-streaming item", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "reasoning", text: "Checking the logs first" },
        { type: "text", text: "Looks fine." },
      ]),
    ]);

    expect(items).toHaveLength(2);
    const thinking = items[0] as ThinkingItem;
    expect(thinking.kind).toBe("thinking");
    expect(thinking.text).toBe("Checking the logs first");
    expect(thinking.streaming).toBe(false);
    expect(items[1]).toMatchObject({ kind: "agent_text", text: "Looks fine." });
  });

  it("preserves occurrence order across multiple thinking bursts and tool calls", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "reasoning", text: "First, check the container" },
        {
          type: "tool_call",
          id: "tu-1",
          name: "check_service_status",
          input: {},
        },
      ]),
      assistantMessage(2, [
        { type: "reasoning", text: "Now decide on a fix" },
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

  it("drops a whitespace-only thinking block so no bare item renders", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "reasoning", text: "\n  \t" },
        { type: "text", text: "Done." },
      ]),
    ]);

    expect(items.some((i) => i.kind === "thinking")).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent_text", text: "Done." });
  });

  it("assigns each thinking block a stable, unique id", () => {
    const items = convertPersistedMessages([
      assistantMessage(1, [
        { type: "reasoning", text: "burst one" },
        { type: "reasoning", text: "burst two" },
      ]),
    ]);

    const ids = items.map((i) => (i as ThinkingItem).id);
    expect(new Set(ids).size).toBe(2);
  });
});
