import { describe, it, expect } from "vitest";
import type { ConsoleEvent, SessionMessage } from "@nightwatch/shared";

import { applyLiveEvent } from "@/components/transcript/liveConverter";
import { convertPersistedMessages } from "@/components/transcript/persistedConverter";
import type { TranscriptItem } from "@/components/transcript/types";

const SESSION_ID = "s1";

/* Strip ephemeral fields (id, streaming) so the same logical content produced via live deltas vs persisted messages compares equal. */
function comparable(items: TranscriptItem[]): unknown[] {
  return items.map((item) => {
    const copy: Record<string, unknown> = { ...item };
    delete copy.id;
    if ("streaming" in copy) delete copy.streaming;
    return copy;
  });
}

function assistantMessage(
  seq: number,
  providerContent: unknown,
): SessionMessage {
  return {
    id: `m${seq}`,
    sessionId: SESSION_ID,
    seq,
    role: "assistant",
    content: "",
    providerContent,
    createdAt: "2024-01-01T00:00:00Z",
  } as unknown as SessionMessage;
}

function userMessage(seq: number, providerContent: unknown): SessionMessage {
  return {
    id: `m${seq}`,
    sessionId: SESSION_ID,
    seq,
    role: "user",
    content: "",
    providerContent,
    createdAt: "2024-01-01T00:00:01Z",
  } as unknown as SessionMessage;
}

function textDelta(delta: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: SESSION_ID, kind: "text", delta },
  };
}

function thinkingDelta(delta: string): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId: SESSION_ID, kind: "thinking", delta },
  };
}

function toolCallStart(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): ConsoleEvent {
  return {
    messageId: "m1",
    type: "TOOL_CALL_START",
    payload: { sessionId: SESSION_ID, toolUseId, toolName, input },
  };
}

function toolCallEnd(toolUseId: string, result: unknown): ConsoleEvent {
  return {
    messageId: "m2",
    type: "TOOL_CALL_END",
    payload: { sessionId: SESSION_ID, toolUseId, result },
  };
}

describe("live vs persisted converter consistency", () => {
  it("produces the same thinking + agent text + tool card (with result) for an equivalent run", () => {
    // Live path: streaming deltas and tool events
    let live: TranscriptItem[] = [];
    live = applyLiveEvent(
      live,
      thinkingDelta("Let me check the logs."),
      SESSION_ID,
    );
    live = applyLiveEvent(live, textDelta("The service is down."), SESSION_ID);
    live = applyLiveEvent(
      live,
      toolCallStart("tu-1", "check_service_status", { service: "web" }),
      SESSION_ID,
    );
    live = applyLiveEvent(
      live,
      toolCallEnd("tu-1", { status: "down" }),
      SESSION_ID,
    );

    // Persisted path: the same run saved as provider messages
    const persisted = convertPersistedMessages([
      assistantMessage(1, [
        { type: "thinking", thinking: "Let me check the logs." },
        { type: "text", text: "The service is down." },
        {
          type: "tool_use",
          id: "tu-1",
          name: "check_service_status",
          input: { service: "web" },
        },
      ]),
      userMessage(2, [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: { status: "down" },
        },
      ]),
    ]);

    expect(comparable(live)).toEqual(comparable(persisted));
  });

  it("preserves the same order across multiple thinking bursts and tool calls", () => {
    let live: TranscriptItem[] = [];
    live = applyLiveEvent(live, thinkingDelta("First burst"), SESSION_ID);
    live = applyLiveEvent(
      live,
      toolCallStart("tu-1", "check_service_status", {}),
      SESSION_ID,
    );
    live = applyLiveEvent(live, toolCallEnd("tu-1", { ok: true }), SESSION_ID);
    live = applyLiveEvent(live, thinkingDelta("Second burst"), SESSION_ID);
    live = applyLiveEvent(live, textDelta("Done."), SESSION_ID);

    const persisted = convertPersistedMessages([
      assistantMessage(1, [
        { type: "thinking", thinking: "First burst" },
        {
          type: "tool_use",
          id: "tu-1",
          name: "check_service_status",
          input: {},
        },
      ]),
      userMessage(2, [
        { type: "tool_result", tool_use_id: "tu-1", content: { ok: true } },
      ]),
      assistantMessage(3, [
        { type: "thinking", thinking: "Second burst" },
        { type: "text", text: "Done." },
      ]),
    ]);

    expect(comparable(live)).toEqual(comparable(persisted));
  });

  it("produces the same tool card when a tool call has no result (still in flight live, no tool_result persisted)", () => {
    let live: TranscriptItem[] = [];
    live = applyLiveEvent(
      live,
      toolCallStart("tu-2", "restart_service", { service: "db" }),
      SESSION_ID,
    );
    // No TOOL_CALL_END — tool is still in flight

    const persisted = convertPersistedMessages([
      assistantMessage(1, [
        {
          type: "tool_use",
          id: "tu-2",
          name: "restart_service",
          input: { service: "db" },
        },
      ]),
      // No user message with a tool_result
    ]);

    expect(comparable(live)).toEqual(comparable(persisted));
  });
});
