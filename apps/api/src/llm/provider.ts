import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { messagePartsToText } from "@nightwarden/shared";
import type {
  MessagePart,
  PartProviderOptions,
  ToolName,
} from "@nightwarden/shared";
import { logger } from "../logger.js";
import type {
  ChatResponse,
  LLMProvider,
  OnDelta,
  ProviderMessage,
  StopReason,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./types.js";

/* Marks the stable prefix a run repeats on every turn. Priced by one provider
   and inert for the rest, which is why it rides on the part rather than a call. */
const CACHE_BREAKPOINT: PartProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

// A summary the provider wrote in place of the turns above it, marked so it
// goes back as the block it came from rather than as ordinary prose.
const COMPACTION: PartProviderOptions = { anthropic: { type: "compaction" } };

export interface SdkProviderOptions {
  maxOutputTokens: number;
  // Reasoning and context management, resolved for this provider by the factory.
  providerOptions: SharedV4ProviderOptions;
}

function textOf(parts: readonly MessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

type AssistantContent = Extract<
  LanguageModelV4Message,
  { role: "assistant" }
>["content"];

function assistantContent(parts: readonly MessagePart[]): AssistantContent {
  return parts.flatMap((part): AssistantContent => {
    switch (part.type) {
      case "text":
        return part.text ? [{ type: "text", text: part.text }] : [];
      // A block standing for turns whose summary it cannot reproduce is worse
      // than no block, which is what a row written without one holds.
      case "compaction":
        return part.text
          ? [{ type: "text", text: part.text, providerOptions: COMPACTION }]
          : [];
      case "reasoning":
        return [
          {
            type: "reasoning",
            text: part.text,
            ...(part.providerOptions && {
              providerOptions: part.providerOptions,
            }),
          },
        ];
      case "tool_call":
        return [
          {
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.name,
            input: part.input,
          },
        ];
      default:
        return [];
    }
  });
}

function resultOutput(
  output: string,
  isError: boolean,
): LanguageModelV4ToolResultOutput {
  return isError
    ? { type: "error-text", value: output }
    : { type: "text", value: output };
}

/* One turn can become two messages: a tool result is its own role here, and an
   injected alert rides alongside the results it arrived with. */
function userMessages(
  parts: readonly MessagePart[],
  toolNames: ReadonlyMap<string, string>,
): LanguageModelV4Message[] {
  const results = parts.filter((p) => p.type === "tool_result");
  const text = textOf(parts);
  const messages: LanguageModelV4Message[] = [];
  if (results.length > 0) {
    messages.push({
      role: "tool",
      content: results.map((part, i) => ({
        type: "tool-result" as const,
        toolCallId: part.toolCallId,
        toolName: toolNames.get(part.toolCallId) ?? "",
        output: resultOutput(part.output, part.isError === true),
        // Rolling breakpoint on the tail, so a growing history caches forward.
        ...(i === results.length - 1 && { providerOptions: CACHE_BREAKPOINT }),
      })),
    });
  }
  if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
  return messages;
}

function promptFrom(
  system: string,
  turns: readonly ProviderMessage[],
): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [
    { role: "system", content: system, providerOptions: CACHE_BREAKPOINT },
  ];
  // A result names the tool it answers, which only the call that made it says.
  const toolNames = new Map<string, string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type === "tool_call") toolNames.set(part.toolCallId, part.name);
    }
    if (turn.role === "assistant") {
      const content = assistantContent(turn.parts);
      if (content.length > 0) prompt.push({ role: "assistant", content });
      continue;
    }
    prompt.push(...userMessages(turn.parts, toolNames));
  }
  return prompt;
}

// The provider's own six, unmapped. A reason absent from this table is unknown
// rather than an ending, so nothing new can read as a turn the model finished.
const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: "done",
  "tool-calls": "tools",
  length: "length",
  "content-filter": "filtered",
  error: "error",
  other: "unknown",
};

/* Model-generated JSON can be malformed; empty input reaches per-tool validation,
   which refuses it with a correction rather than crashing the run. */
function parseToolInput(raw: string, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* the warning below covers both a parse failure and a non-object */
  }
  logger.warn({ tool: name, raw }, "tool arguments were not a JSON object");
  return {};
}

// The three shapes a stream fills in over successive deltas, held open by id.
type StreamedPart = Extract<
  MessagePart,
  { type: "text" | "reasoning" | "compaction" }
>;

/* Reasoning is kept whatever it says: a signature the provider requires back
   can arrive on a block whose summary was omitted. */
function saidNothing(part: MessagePart): boolean {
  return (
    (part.type === "text" || part.type === "compaction") && part.text === ""
  );
}

function mergeOptions(
  held: PartProviderOptions | undefined,
  arriving: PartProviderOptions,
): PartProviderOptions {
  const merged: PartProviderOptions = { ...held };
  for (const [provider, values] of Object.entries(arriving)) {
    merged[provider] = { ...merged[provider], ...values };
  }
  return merged;
}

export class SdkProvider implements LLMProvider {
  private turns: ProviderMessage[] = [];

  constructor(
    private readonly model: LanguageModelV4,
    private readonly system: string,
    private readonly opts: SdkProviderOptions,
  ) {}

  start(firstMessage: string): void {
    this.turns = [];
    this.appendUserMessage(firstMessage);
  }

  seed(history: ProviderMessage[]): void {
    this.turns = [...history];
  }

  appendUserMessage(message: string): void {
    this.stage([{ type: "text", text: message }]);
  }

  appendToolResults(results: ToolResult[]): void {
    this.stage(
      results.map((r) => ({
        type: "tool_result",
        toolCallId: r.toolCallId,
        output: r.content,
        ...(r.isError === true && { isError: true as const }),
      })),
    );
  }

  async chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
    forceTool?: ToolName,
  ): Promise<ChatResponse> {
    const call: LanguageModelV4CallOptions = {
      prompt: promptFrom(this.system, this.turns),
      maxOutputTokens: this.opts.maxOutputTokens,
      tools: tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        // Constrains sampling to the schema and guarantees the tool name is one
        // of these; each provider is sent only the keywords it documents.
        strict: true,
      })),
      ...(forceTool !== undefined && {
        toolChoice: { type: "tool" as const, toolName: forceTool },
      }),
      ...(signal !== undefined && { abortSignal: signal }),
      providerOptions: this.opts.providerOptions,
    };

    const { stream } = await this.model.doStream(call);
    const { parts, toolUses, stopReason } = await this.accumulate(
      stream,
      onDelta,
    );
    this.turns.push({
      role: "assistant",
      content: messagePartsToText(parts),
      parts,
    });
    return { stopReason, toolUses, text: textOf(parts), parts };
  }

  private stage(parts: MessagePart[]): void {
    this.turns.push({
      role: "user",
      content: messagePartsToText(parts),
      parts,
    });
  }

  /* Blocks arrive interleaved and each is held open by its id until its own end,
     so the parts come out in the order the model opened them. */
  private async accumulate(
    stream: ReadableStream<LanguageModelV4StreamPart>,
    onDelta?: OnDelta,
  ): Promise<{
    parts: MessagePart[];
    toolUses: ToolUse[];
    stopReason: StopReason;
  }> {
    const parts: MessagePart[] = [];
    const toolUses: ToolUse[] = [];
    const open = new Map<string, StreamedPart>();
    let stopReason: StopReason = "done";

    for await (const event of stream) {
      switch (event.type) {
        case "text-start":
        case "reasoning-start": {
          const part: StreamedPart =
            event.type === "reasoning-start"
              ? { type: "reasoning", text: "" }
              : event.providerMetadata?.["anthropic"]?.["type"] === "compaction"
                ? { type: "compaction", text: "" }
                : { type: "text", text: "" };
          open.set(event.id, part);
          parts.push(part);
          break;
        }
        case "text-delta":
        case "reasoning-delta": {
          const part = open.get(event.id);
          if (part === undefined) break;
          part.text += event.delta;
          // The signature rides an empty delta at the block's end, so it is
          // merged in rather than replacing what earlier deltas carried.
          if (part.type === "reasoning" && event.providerMetadata) {
            part.providerOptions = mergeOptions(
              part.providerOptions,
              event.providerMetadata,
            );
          }
          if (event.delta) {
            onDelta?.({
              kind: event.type === "reasoning-delta" ? "thinking" : "text",
              text: event.delta,
            });
          }
          break;
        }
        case "tool-call": {
          const input = parseToolInput(event.input, event.toolName);
          toolUses.push({
            toolCallId: event.toolCallId,
            name: event.toolName,
            input,
          });
          parts.push({
            type: "tool_call",
            toolCallId: event.toolCallId,
            name: event.toolName,
            input,
          });
          break;
        }
        case "finish": {
          stopReason = STOP_REASONS[event.finishReason.unified] ?? "unknown";
          logger.info(
            {
              model: this.model.modelId,
              turns: this.turns.length,
              // Kept for diagnosis alone: nothing branches on a provider's word.
              stopReason,
              ...(stopReason === "unknown" && {
                reported: event.finishReason.raw ?? event.finishReason.unified,
              }),
              input: event.usage.inputTokens.total,
              output: event.usage.outputTokens.total,
              cacheRead: event.usage.inputTokens.cacheRead,
              cacheWrite: event.usage.inputTokens.cacheWrite,
            },
            "LLM usage",
          );
          break;
        }
        // The request failed part way; returning what arrived would read as a
        // turn the model finished.
        case "error":
          throw event.error;
        default:
          break;
      }
    }

    return {
      parts: parts.filter((p) => !saidNothing(p)),
      toolUses,
      stopReason,
    };
  }
}
