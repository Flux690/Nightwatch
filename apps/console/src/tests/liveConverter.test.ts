import { describe, it, expect } from "vitest";
import type { ConsoleEvent } from "@nightwatch/shared";

import { applyLiveEvent } from "../transcript/liveConverter.js";
import type { TranscriptItem, ThinkingItem } from "../transcript/types.js";

function textDelta(delta: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: "s1", kind: "text", delta },
  };
}

function thinkingDelta(delta: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: "s1", kind: "thinking", delta },
  };
}

function toolCallStart(toolUseId: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TOOL_CALL_START",
    payload: {
      sessionId: "s1",
      toolUseId,
      toolName: "check_service_status",
      input: {},
    },
  };
}

function interrupt(toolUseId: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "HUMAN_INPUT_REQUIRED",
    payload: {
      sessionId: "s1",
      kind: "approval",
      toolUseId,
      toolName: "restart_container",
      input: { risk: "high" },
    },
  };
}

describe("applyLiveEvent — thinking", () => {
  it("opens a streaming thinking item on the first delta", () => {
    const items = applyLiveEvent([], thinkingDelta("Let me check"), "s1");

    expect(items).toHaveLength(1);
    const item = items[0] as ThinkingItem;
    expect(item.kind).toBe("thinking");
    expect(item.text).toBe("Let me check");
    expect(item.streaming).toBe(true);
  });

  it("accumulates consecutive thinking deltas into the same item", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("Let me check"), "s1");
    items = applyLiveEvent(items, thinkingDelta(" the logs"), "s1");

    expect(items).toHaveLength(1);
    expect((items[0] as ThinkingItem).text).toBe("Let me check the logs");
  });

  it("stops streaming the thinking item the moment a text delta arrives", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("Let me check"), "s1");
    items = applyLiveEvent(items, textDelta("Checked."), "s1");

    expect(items).toHaveLength(2);
    const thinking = items[0] as ThinkingItem;
    expect(thinking.streaming).toBe(false);
    expect(items[1]).toMatchObject({ kind: "agent_text", text: "Checked." });
  });

  it("stops streaming the thinking item the moment a tool call starts", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("Let me check"), "s1");
    items = applyLiveEvent(items, toolCallStart("tu-1"), "s1");

    expect(items).toHaveLength(2);
    const thinking = items[0] as ThinkingItem;
    expect(thinking.streaming).toBe(false);
    expect(items[1]).toMatchObject({ kind: "tool_card", toolUseId: "tu-1" });
  });

  it("stops streaming the thinking item the moment an interrupt arrives", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("Should I restart it?"), "s1");
    items = applyLiveEvent(items, interrupt("tu-gate"), "s1");

    expect(items).toHaveLength(2);
    const thinking = items[0] as ThinkingItem;
    expect(thinking.streaming).toBe(false);
    expect(items[1]).toMatchObject({
      kind: "approval_card",
      toolUseId: "tu-gate",
    });
  });

  it("starts a new, independent thinking item for the next burst", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("First burst"), "s1");
    items = applyLiveEvent(items, toolCallStart("tu-1"), "s1");
    items = applyLiveEvent(items, thinkingDelta("Second burst"), "s1");

    expect(items).toHaveLength(3);
    expect((items[0] as ThinkingItem).text).toBe("First burst");
    expect((items[0] as ThinkingItem).streaming).toBe(false);
    const second = items[2] as ThinkingItem;
    expect(second.text).toBe("Second burst");
    expect(second.streaming).toBe(true);
  });

  it("ignores thinking deltas for a different session", () => {
    const items = applyLiveEvent([], thinkingDelta("ignored"), "other-session");

    expect(items).toHaveLength(0);
  });
});
