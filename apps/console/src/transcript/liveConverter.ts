import type {
  WsEnvelope,
  ConsoleToolCallStart,
  ConsoleInterrupt,
  ConsoleToolCallEnd,
  ConsoleInterruptResolved,
} from "@nightwatch/shared";
import type {
  TranscriptItem,
  ApprovalCardItem,
  ClarificationCardItem,
} from "./types.js";

export function applyLiveEvent(
  items: TranscriptItem[],
  env: WsEnvelope,
  sessionId: string,
): TranscriptItem[] {
  if (env.type === "TEXT_MESSAGE_CONTENT") {
    const payload = env.payload as {
      sessionId: string;
      kind: string;
      delta: string;
    };
    if (payload.sessionId !== sessionId || payload.kind !== "text")
      return items;

    const last = items[items.length - 1];
    if (last?.kind === "agent_text") {
      return [
        ...items.slice(0, -1),
        { ...last, text: last.text + payload.delta },
      ];
    }
    return [
      ...items,
      { kind: "agent_text", id: `agent-${Date.now()}`, text: payload.delta },
    ];
  }

  if (env.type === "TOOL_CALL_START") {
    const payload = env.payload as ConsoleToolCallStart["payload"];
    if (payload.sessionId !== sessionId) return items;
    return [
      ...items,
      {
        kind: "tool_card",
        toolUseId: payload.toolUseId,
        toolName: payload.toolName,
        input: payload.input,
        result: null,
      },
    ];
  }

  if (env.type === "INTERRUPT") {
    const payload = env.payload as ConsoleInterrupt["payload"];
    if (payload.sessionId !== sessionId) return items;

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
        result: null,
        risk: typeof riskValue === "string" ? riskValue : undefined,
      },
    ];
  }

  if (env.type === "TOOL_CALL_END") {
    const payload = env.payload as ConsoleToolCallEnd["payload"];
    if (payload.sessionId !== sessionId) return items;
    return items.map((item) => {
      if (
        (item.kind === "tool_card" || item.kind === "approval_card") &&
        item.toolUseId === payload.toolUseId
      ) {
        return { ...item, result: payload.result ?? null };
      }
      return item;
    });
  }

  if (env.type === "INTERRUPT_RESOLVED") {
    const payload = env.payload as ConsoleInterruptResolved["payload"];
    const { status, resolvedBy } = payload;
    return items.map((item) => {
      if (
        item.kind === "approval_card" &&
        item.toolUseId === payload.toolUseId
      ) {
        const approval: ApprovalCardItem["approval"] =
          status === "approved" || status === "rejected" ? status : "pending";
        return { ...item, approval, resolvedBy };
      }
      if (
        item.kind === "clarification_card" &&
        item.toolUseId === payload.toolUseId
      ) {
        const approval: ClarificationCardItem["approval"] =
          status === "answered" ? "answered" : "pending";
        return { ...item, approval, resolvedBy };
      }
      return item;
    });
  }

  return items;
}
