import { vi } from "vitest";
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

    if (prev.role === curr.role) {
      throw new Error(
        `Contract violation: consecutive ${prev.role} messages at index ${i - 1} and ${i}`,
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

export type ContractFakeProvider = {
  [K in keyof LLMProvider]: LLMProvider[K] & ReturnType<typeof vi.fn>;
};

const DEFAULT_TURN: ScriptedTurn = { toolUses: [], text: "Done." };

// Core fake builder. `nextTurn` is called once per chat() to get the turn to
// emit - either an array-backed per-instance source (createContractFakeProvider)
// or a module-level shared-index source (createScriptRunner).
function makeProvider(
  nextTurn: () => ScriptedTurn,
  opts?: { gate?: () => Promise<void> },
): ContractFakeProvider {
  const messages: NativeMessage[] = [];

  function toProviderMessages(): ProviderMessage[] {
    return messages.map((m) => ({
      role: m.role,
      content: nativeToText(m),
      providerContent: m,
    }));
  }

  return {
    start: vi.fn((msg: string) => {
      messages.push({ role: "user", content: msg });
    }),

    seed: vi.fn((history: ProviderMessage[]) => {
      const native = history.map((m) => m.providerContent as NativeMessage);
      validateTranscript(native);
      messages.length = 0;
      messages.push(...native);
    }),

    snapshot: vi.fn((): ProviderMessage[] => toProviderMessages()),

    chat: vi.fn(
      async (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
      ): Promise<ChatResponse> => {
        // Optional gate: park here until the test releases this turn, so timing
        // tests can act (e.g. inject an alert) while a run is mid-chat. No gate
        // means immediate resolution (the common case).
        if (opts?.gate) await opts.gate();
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

    appendToolResults: vi.fn(
      (results: ToolResult[], additionalText?: string) => {
        const blocks: Array<ToolResultBlock | TextBlock> = results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          content: r.content,
          ...(r.is_error && { is_error: true }),
        }));
        if (additionalText) {
          blocks.push({ type: "text", text: additionalText });
        }
        messages.push({ role: "user", content: blocks });
      },
    ),

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

// Module-level script shared across instances: setScript resets the sequence and successive
// runs (suspend then resume) continue where the last left off, preserving the per-file
// setScript([...]) pattern so converting a file needs no per-run rewrites.
export interface ScriptRunner {
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
// releaseNext()/releaseAll(), the faithful equivalent of the old per-file `gates` arrays for
// timing tests (e.g. mid-run injection). Non-timing tests omit it and chat() resolves at once.
export interface GateController {
  gate: () => Promise<void>;
  releaseNext: () => void;
  releaseAll: () => void;
}

export function createGateController(): GateController {
  const pending: Array<() => void> = [];
  return {
    gate: () => new Promise<void>((resolve) => pending.push(resolve)),
    releaseNext: () => pending.shift()?.(),
    releaseAll: () => {
      const copy = [...pending];
      pending.length = 0;
      for (const resolve of copy) resolve();
    },
  };
}
