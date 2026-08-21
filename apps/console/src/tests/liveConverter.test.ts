import { describe, it, expect } from "vitest";
import type { ConsoleEvent } from "@nightwarden/shared";

import {
  applyLiveEvent,
  hasActiveStream,
} from "@/components/transcript/liveConverter";
import type {
  TranscriptItem,
  ThinkingItem,
} from "@/components/transcript/types";

function textDelta(delta: string, turn = 1): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: "s1", kind: "text", delta, turn },
  };
}

function thinkingDelta(delta: string, turn = 1): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: "s1", kind: "thinking", delta, turn },
  };
}

// The API builds the card; these mirror what it sends.
function itemEvent(item: TranscriptItem): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TRANSCRIPT_ITEM",
    payload: { sessionId: "s1", item },
  };
}

function toolCallStart(toolUseId: string): ConsoleEvent {
  return itemEvent({
    kind: "tool_call",
    toolUseId,
    toolName: "check_service_status",
    input: {},
    state: { phase: "running" },
  });
}

function toolCallEnd(toolUseId: string, result: unknown): ConsoleEvent {
  return itemEvent({
    kind: "tool_call",
    toolUseId,
    toolName: "check_service_status",
    input: {},
    state: { phase: "complete", result },
  });
}

function interrupt(toolUseId: string): ConsoleEvent {
  return itemEvent({
    kind: "tool_call",
    toolUseId,
    toolName: "RestartDockerService",
    input: { risk: "high" },
    state: { phase: "awaiting_human", gate: "approval" },
  });
}

function continueInterrupt(toolUseId: string): ConsoleEvent {
  return itemEvent({
    kind: "continue_card",
    toolUseId,
    state: { phase: "awaiting_human" },
  });
}

function interruptResolved(
  toolUseId: string,
  status: "approved" | "rejected" | "answered" | "continued",
): ConsoleEvent {
  return itemEvent({
    kind: "continue_card",
    toolUseId,
    state: { phase: "resolved", decision: status },
  });
}

describe("applyLiveEvent — continue interrupt", () => {
  it("inserts the continue card the API sent", () => {
    const items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "continue_card",
      toolUseId: "ci-1",
    });
  });

  it("resolves the card with the decision", () => {
    let items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");
    items = applyLiveEvent(items, interruptResolved("ci-1", "continued"), "s1");

    expect(items[0]).toMatchObject({
      kind: "continue_card",
      state: { phase: "resolved", decision: "continued" },
    });
  });

  it("carries a rejection through as the decision, not a generic pending state", () => {
    let items = applyLiveEvent([], continueInterrupt("ci-1"), "s1");
    items = applyLiveEvent(items, interruptResolved("ci-1", "rejected"), "s1");

    expect(items[0]).toMatchObject({
      kind: "continue_card",
      state: { phase: "resolved", decision: "rejected" },
    });
  });

  it("finalizes a trailing thinking item before adding the continue card", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(
      items,
      {
        messageId: "m1",
        type: "TEXT_MESSAGE_CONTENT",
        payload: { sessionId: "s1", kind: "thinking", delta: "Hmm…", turn: 1 },
      },
      "s1",
    );
    items = applyLiveEvent(items, continueInterrupt("ci-2"), "s1");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "thinking", streaming: false });
    expect(items[1]).toMatchObject({
      kind: "continue_card",
      toolUseId: "ci-2",
    });
  });
});

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

  /* One rule with three ways of arriving: anything that is not another thinking
     delta settles the burst. A row per event, not a case per event. */
  it.each([
    ["a text delta", () => textDelta("Checked."), "agent_text"],
    ["a tool call", () => toolCallStart("tu-1"), "tool_call"],
    ["an interrupt", () => interrupt("tu-gate"), "tool_call"],
  ])("stops streaming the moment %s arrives", (_label, event, kind) => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("Let me check"), "s1");
    items = applyLiveEvent(items, event(), "s1");

    expect(items).toHaveLength(2);
    expect((items[0] as ThinkingItem).streaming).toBe(false);
    expect(items[1]).toMatchObject({ kind });
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

  it("drops a whitespace-only thinking burst instead of leaving a bare item", () => {
    let items: TranscriptItem[] = [];
    items = applyLiveEvent(items, thinkingDelta("\n  "), "s1");
    // Still streaming, so it lingers until finalized.
    expect(items).toHaveLength(1);
    // A text delta finalizes the burst; whitespace-only means it is discarded.
    items = applyLiveEvent(items, textDelta("Answer."), "s1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent_text", text: "Answer." });
  });
});

describe("hasActiveStream", () => {
  it("is false for an empty transcript", () => {
    expect(hasActiveStream([])).toBe(false);
  });

  it("is true while a thinking item streams real text", () => {
    const items = applyLiveEvent([], thinkingDelta("Reasoning"), "s1");
    expect(hasActiveStream(items)).toBe(true);
  });

  it("is false while a thinking item has only whitespace", () => {
    const items = applyLiveEvent([], thinkingDelta("   "), "s1");
    expect(hasActiveStream(items)).toBe(false);
  });

  it("is true while answer text streams", () => {
    const items = applyLiveEvent([], textDelta("Here is"), "s1");
    expect(hasActiveStream(items)).toBe(true);
  });

  it("is true while a tool card is in flight, false once it resolves", () => {
    let items = applyLiveEvent([], toolCallStart("tu-1"), "s1");
    expect(hasActiveStream(items)).toBe(true);
    items = applyLiveEvent(items, toolCallEnd("tu-1", "ok"), "s1");
    expect(hasActiveStream(items)).toBe(false);
  });

  it("is false when the tail is a settled thinking item", () => {
    let items = applyLiveEvent([], thinkingDelta("Reasoning"), "s1");
    items = applyLiveEvent(items, toolCallStart("tu-1"), "s1");
    // Tail is now an in-flight tool card; drop it to expose the finalized thinking.
    items = items.slice(0, 1);
    expect(items[0]).toMatchObject({ kind: "thinking", streaming: false });
    expect(hasActiveStream(items)).toBe(false);
  });
});
