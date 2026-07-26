import type { ConsoleEvent } from "@nightwarden/shared";
import type { TranscriptItem, ThinkingItem, ToolCallState } from "./types.js";

// A non-thinking event finalizes the most recent streaming thinking burst;
// a later thinking delta opens a fresh item rather than reopening this one.
// A burst that carried only whitespace (no real reasoning) is dropped outright
// so no empty "Thinking" line survives it - the working animation covers that gap.
function finalizeTrailingThinking(items: TranscriptItem[]): TranscriptItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    if (!last.text.trim()) return items.slice(0, -1);
    const finalized: ThinkingItem = { ...last, streaming: false };
    return [...items.slice(0, -1), finalized];
  }
  return items;
}

// Whether the live tail is actively producing output the user can see: streamed
// reasoning with real text, streamed answer text, or an in-flight tool card. When
// false during a run, nothing is on screen yet, so the working animation shows.
export function hasActiveStream(items: TranscriptItem[]): boolean {
  const last = items[items.length - 1];
  if (!last) return false;
  if (last.kind === "thinking")
    return last.streaming && last.text.trim() !== "";
  if (last.kind === "agent_text") return true;
  if (last.kind === "tool_card") return last.state.phase === "running";
  return false;
}

export function applyLiveEvent(
  items: TranscriptItem[],
  env: ConsoleEvent,
  sessionId: string,
): TranscriptItem[] {
  if (env.type === "TEXT_MESSAGE_CONTENT") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;

    if (payload.kind === "thinking") {
      const last = items[items.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        return [
          ...items.slice(0, -1),
          { ...last, text: last.text + payload.delta },
        ];
      }
      return [
        ...items,
        {
          kind: "thinking",
          id: `thinking-${Date.now()}`,
          text: payload.delta,
          streaming: true,
        },
      ];
    }

    if (payload.kind !== "text") return items;

    const settled = finalizeTrailingThinking(items);
    const last = settled[settled.length - 1];
    if (last?.kind === "agent_text") {
      return [
        ...settled.slice(0, -1),
        { ...last, text: last.text + payload.delta },
      ];
    }
    return [
      ...settled,
      { kind: "agent_text", id: `agent-${Date.now()}`, text: payload.delta },
    ];
  }

  if (env.type === "TOOL_CALL_START") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    return [
      ...finalizeTrailingThinking(items),
      {
        kind: "tool_card",
        toolUseId: payload.toolUseId,
        toolName: payload.toolName,
        input: payload.input,
        state: { phase: "running" },
      },
    ];
  }

  if (env.type === "HUMAN_INPUT_REQUIRED") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    items = finalizeTrailingThinking(items);

    if (payload.kind === "clarification") {
      return [
        ...items,
        {
          kind: "clarification_card",
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          input: payload.input,
          question: payload.question,
          options: payload.options,
          multiSelect: payload.multiSelect,
          state: { phase: "awaiting_human" },
        },
      ];
    }

    if (payload.kind === "continue") {
      return [
        ...items,
        {
          kind: "continue_card",
          toolUseId: payload.toolUseId,
          state: { phase: "awaiting_human" },
        },
      ];
    }

    const riskValue = payload.input["risk"];
    return [
      ...items,
      {
        kind: "approval_card",
        toolUseId: payload.toolUseId,
        toolName: payload.toolName,
        input: payload.input,
        risk: typeof riskValue === "string" ? riskValue : undefined,
        state: { phase: "awaiting_human" },
      },
    ];
  }

  if (env.type === "TOOL_CALL_END") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    return items.map((item) => {
      if (
        (item.kind === "tool_card" || item.kind === "approval_card") &&
        item.toolUseId === payload.toolUseId
      ) {
        const result = payload.result ?? null;
        const state: ToolCallState =
          item.state.phase === "resolved"
            ? { ...item.state, result }
            : { phase: "complete", result };
        return { ...item, state };
      }
      return item;
    });
  }

  if (env.type === "HUMAN_INPUT_RESOLVED") {
    const payload = env.payload;
    const { status, resolvedBy } = payload;
    return items.map((item) => {
      const isCard =
        item.kind === "approval_card" ||
        item.kind === "clarification_card" ||
        item.kind === "continue_card";
      if (!isCard || item.toolUseId !== payload.toolUseId) return item;
      // The approved tool can finish before its resolution arrives, so a result
      // already in hand carries over rather than being overwritten.
      const known =
        item.state.phase === "complete" ? item.state.result : undefined;
      const state: ToolCallState = {
        phase: "resolved",
        decision: status,
        ...(resolvedBy && { by: resolvedBy }),
        ...(known !== undefined && { result: known }),
      };
      return { ...item, state };
    });
  }

  return items;
}
