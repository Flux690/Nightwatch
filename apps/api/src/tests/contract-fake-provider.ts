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

export function createContractFakeProvider(
  script: ScriptedTurn[],
): ContractFakeProvider {
  const messages: NativeMessage[] = [];
  let scriptIndex = 0;

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
      (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
      ): Promise<ChatResponse> => {
        const turn = script[scriptIndex++] ??
          script[script.length - 1] ?? { toolUses: [], text: "Done." };
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
