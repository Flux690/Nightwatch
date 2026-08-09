import { vi } from "vitest";
import type { MessagePart, WireDialect } from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolResult,
} from "../llm/types.js";

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AssistantContent = Array<TextBlock | ToolUseBlock>;
type UserContent = string | Array<ToolResultBlock | TextBlock>;

interface NativeAssistantMessage {
  role: "assistant";
  content: AssistantContent;
}

interface NativeUserMessage {
  role: "user";
  content: UserContent;
}

type NativeMessage = NativeAssistantMessage | NativeUserMessage;

export interface ScriptedTurn {
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  text: string;
  stopReason?: ChatResponse["stopReason"];
}

function extractToolUseIds(msg: NativeMessage): string[] {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
  return msg.content
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => b.id);
}

function validateTranscript(messages: NativeMessage[]): void {
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!;
    const curr = messages[i]!;

    // Consecutive user turns are legal - the Messages API combines them into
    // one - which is what lets an injected alert follow the tool results as its
    // own turn. Two assistant turns in a row is still a bug.
    if (prev.role === "assistant" && curr.role === "assistant") {
      throw new Error(
        `Contract violation: consecutive assistant messages at index ${i - 1} and ${i}`,
      );
    }

    const toolUseIds = extractToolUseIds(prev);
    if (toolUseIds.length > 0) {
      if (curr.role !== "user") {
        throw new Error(
          `Contract violation: tool_use at index ${i - 1} not followed by user message`,
        );
      }
      const resultIds = new Set<string>();
      if (Array.isArray(curr.content)) {
        for (const block of curr.content) {
          if (block.type === "tool_result") resultIds.add(block.tool_use_id);
        }
      }
      for (const id of toolUseIds) {
        if (!resultIds.has(id)) {
          throw new Error(
            `Contract violation: tool_use ${id} at index ${i - 1} has no matching tool_result`,
          );
        }
      }
    }
  }
}

function nativeToText(m: NativeMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[tool_use: ${b.name}]`;
      if (b.type === "tool_result") return b.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// The fake's native shape mirrors Anthropic's blocks, so it claims that dialect
// and exercises both halves of the replay contract.
const DIALECT: WireDialect = "anthropic-messages";

function nativeToParts(m: NativeMessage): MessagePart[] {
  if (typeof m.content === "string") {
    return m.content ? [{ type: "text", text: m.content }] : [];
  }
  return m.content.map((b): MessagePart => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use")
      return { type: "tool_call", id: b.id, name: b.name, input: b.input };
    return {
      type: "tool_result",
      toolCallId: b.tool_use_id,
      output: b.content,
      ...(b.is_error && { isError: true }),
    };
  });
}

function partsToNative(m: ProviderMessage): NativeMessage {
  const blocks = m.parts.flatMap((p): Array<TextBlock | ToolUseBlock> =>
    p.type === "text"
      ? [{ type: "text", text: p.text }]
      : p.type === "tool_call"
        ? [{ type: "tool_use", id: p.id, name: p.name, input: p.input }]
        : [],
  );
  if (m.role === "assistant") return { role: "assistant", content: blocks };
  const userBlocks = m.parts.flatMap((p): Array<ToolResultBlock | TextBlock> =>
    p.type === "tool_result"
      ? [
          {
            type: "tool_result",
            tool_use_id: p.toolCallId,
            content: p.output,
            ...(p.isError && { is_error: true }),
          },
        ]
      : p.type === "text"
        ? [{ type: "text", text: p.text }]
        : [],
  );
  return { role: "user", content: userBlocks };
}

export type ContractFakeProvider = {
  [K in keyof LLMProvider]: LLMProvider[K] & ReturnType<typeof vi.fn>;
};

const DEFAULT_TURN: ScriptedTurn = { toolUses: [], text: "Done." };

// `nextTurn` is called once per chat() to get the turn to emit - either an array-backed
// per-instance source or a module-level shared-index source.
function makeProvider(
  nextTurn: () => ScriptedTurn,
  opts?: { gate?: () => Promise<void> },
): ContractFakeProvider {
  const messages: NativeMessage[] = [];

  function toProviderMessages(): ProviderMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: nativeToText(m),
      parts: nativeToParts(m),
      native: { dialect: DIALECT, message: m },
    }));
  }

  return {
    start: vi.fn((msg: string) => {
      messages.push({ role: "user", content: msg });
    }),

    seed: vi.fn((history: ProviderMessage[]) => {
      // Same split a real adapter makes: replay own-dialect messages verbatim,
      // rebuild the rest from parts.
      const native = history.map((m) =>
        m.native?.dialect === DIALECT
          ? (m.native.message as NativeMessage)
          : partsToNative(m),
      );
      validateTranscript(native);
      messages.length = 0;
      messages.push(...native);
    }),

    snapshot: vi.fn((): ProviderMessage[] => toProviderMessages()),

    chat: vi.fn(
      async (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
        signal?: AbortSignal,
      ): Promise<ChatResponse> => {
        // Optional gate: park here until the test releases this turn, so timing tests
        // can act (e.g. inject an alert) mid-chat. No gate means immediate resolution.
        if (opts?.gate) await opts.gate();
        // A real SDK abandons an in-flight request when the signal fires; a fake
        // that returned a turn anyway would hide every abort bug.
        if (signal?.aborted) throw signal.reason;
        const turn = nextTurn();
        if (onDelta && turn.text) {
          onDelta({ kind: "text", text: turn.text });
        }

        const content: AssistantContent = [];
        if (turn.text) content.push({ type: "text", text: turn.text });
        for (const tu of turn.toolUses) {
          content.push({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
        }

        messages.push({ role: "assistant", content });

        const stopReason: ChatResponse["stopReason"] =
          turn.stopReason ??
          (turn.toolUses.length > 0 ? "tool_use" : "end_turn");

        return Promise.resolve({
          stopReason,
          toolUses: turn.toolUses,
          text: turn.text,
        });
      },
    ),

    appendToolResults: vi.fn((results: ToolResult[]) => {
      const blocks: Array<ToolResultBlock | TextBlock> = results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error && { is_error: true }),
      }));
      messages.push({ role: "user", content: blocks });
    }),

    appendUserMessage: vi.fn((msg: string) => {
      messages.push({ role: "user", content: msg });
    }),
  };
}

// Per-instance script: each provider consumes its own copy from the start. A
// resume/leftover run is a separate run, so chain one provider per run.
export function createContractFakeProvider(
  script: ScriptedTurn[],
  opts?: { gate?: () => Promise<void> },
): ContractFakeProvider {
  let i = 0;
  return makeProvider(
    () => script[i++] ?? script[script.length - 1] ?? DEFAULT_TURN,
    opts,
  );
}

// Module-level script shared across instances: setScript resets the sequence, and successive
// runs (suspend then resume) continue where the last left off.
interface ScriptRunner {
  setScript: (turns: ScriptedTurn[]) => void;
  create: (opts?: { gate?: () => Promise<void> }) => ContractFakeProvider;
}

export function createScriptRunner(): ScriptRunner {
  let script: ScriptedTurn[] = [];
  let i = 0;
  const nextTurn = (): ScriptedTurn =>
    script[i++] ?? script[script.length - 1] ?? DEFAULT_TURN;
  return {
    setScript: (turns: ScriptedTurn[]) => {
      script = turns;
      i = 0;
    },
    create: (opts) => makeProvider(nextTurn, opts),
  };
}

// A FIFO gate shared across instances: pass `gate` so each chat() parks until
// releaseNext()/releaseAll(), for timing tests (e.g. mid-run injection).
interface GateController {
  gate: () => Promise<void>;
  releaseNext: () => void;
  releaseAll: () => void;
  // Releases every turn as it arrives until `done` holds. An investigation ends
  // with a composition turn and possibly a retry, so it parks more times than
  // its script has turns - a test about dispatch mechanics should not have to
  // count them. Real timers only; a faked-clock test drives its own loop.
  releaseUntil: (done: () => boolean, timeoutMs?: number) => Promise<void>;
}

export function createGateController(): GateController {
  const pending: Array<() => void> = [];
  const releaseAll = (): void => {
    const copy = [...pending];
    pending.length = 0;
    for (const resolve of copy) resolve();
  };
  return {
    gate: () => new Promise<void>((resolve) => pending.push(resolve)),
    releaseNext: () => pending.shift()?.(),
    releaseAll,
    releaseUntil: async (done, timeoutMs = 10_000) => {
      const start = Date.now();
      while (!done()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("releaseUntil timed out");
        }
        releaseAll();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}
