import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import { resolveDefault } from "./reasoning.js";
import { messagePartsToText } from "@nightwarden/shared";
import type {
  MessagePart,
  ModelOption,
  ReasoningLevel,
  ResolvedLLMConfig,
  WireDialect,
} from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  OnDelta,
  ProviderCallOptions,
  ProviderMessage,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./types.js";

const DIALECT: WireDialect = "anthropic-messages";

export const ANTHROPIC_MODELS_PATH = "/v1/models";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

// Anthropic's catalog publishes which levels a model accepts but never a
// default, so the API-wide documented default stands in: sending "high" is
// identical to omitting the parameter.
const ANTHROPIC_DEFAULT_EFFORT = "high";

// Strongest first. Every rung is checked independently because the ladder has
// holes: Opus 4.6 supports max but not xhigh.
const ANTHROPIC_EFFORT_LADDER: readonly (ReasoningLevel & {
  value: AnthropicEffort;
})[] = [
  { value: "max", label: "Max" },
  { value: "xhigh", label: "Extra high" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
}

/* Server-side compaction: the conversation is summarised rather than refused
   when it outgrows the window. Safe because the full tool result stays in the
   transcript - the model forgets, the record does not. */
const COMPACTION_BETA = "compact-2026-01-12";

// One identifier, which Anthropic uses both as the edit type on a request and
// as the capability key on a model.
const COMPACTION_ID = "compact_20260112";

/* The share of the window at which to summarise. The one number we choose, and
   a ratio rather than a count so it cannot drift per model: on a 200k window it
   reproduces Anthropic's own documented default of 150,000 exactly. */
const COMPACTION_TRIGGER_RATIO = 0.75;

// The API refuses a lower trigger, so a window too small for the ratio to clear
// it compacts at the floor instead of sending a value that would 400.
const MIN_COMPACTION_TRIGGER = 50_000;

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaMessage = Anthropic.Beta.BetaMessage;

type ThinkingParams = Pick<
  Anthropic.Beta.Messages.MessageCreateParams,
  "thinking" | "output_config"
>;
type CompactionParams = Pick<
  Anthropic.Beta.Messages.MessageCreateParams,
  "betas" | "context_management"
>;
type AnthropicEffort = NonNullable<Anthropic.Beta.BetaOutputConfig["effort"]>;

// The stored level is a plain string; matching it against the ladder narrows it
// to what the SDK accepts without asserting anything.
function toEffort(level: string | null): AnthropicEffort | undefined {
  return ANTHROPIC_EFFORT_LADDER.find((l) => l.value === level)?.value;
}

function effortParam(effort: AnthropicEffort | undefined): ThinkingParams {
  return effort === undefined ? {} : { output_config: { effort } };
}

// Both `capabilities` and the individual `xhigh` rung are nullable in the
// schema, so every hop is checked rather than assumed present.
function effortLevels(capabilities: unknown): ReasoningLevel[] {
  if (typeof capabilities !== "object" || capabilities === null) return [];
  const effort = (capabilities as Record<string, unknown>)["effort"];
  if (typeof effort !== "object" || effort === null) return [];
  const e = effort as Record<string, unknown>;
  if (e["supported"] !== true) return [];
  return ANTHROPIC_EFFORT_LADDER.filter((level) => {
    const rung = e[level.value];
    return (
      typeof rung === "object" &&
      rung !== null &&
      (rung as Record<string, unknown>)["supported"] === true
    );
  });
}

// A model that accepts thinking type "enabled" also accepts "disabled"; one
// that does not has no way to be told to stop reasoning.
function canDisableThinking(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const thinking = (capabilities as Record<string, unknown>)["thinking"];
  if (typeof thinking !== "object" || thinking === null) return false;
  const types = (thinking as Record<string, unknown>)["types"];
  if (typeof types !== "object" || types === null) return false;
  const enabled = (types as Record<string, unknown>)["enabled"];
  return (
    typeof enabled === "object" &&
    enabled !== null &&
    (enabled as Record<string, unknown>)["supported"] === true
  );
}

// Compaction is nested two levels deep and every hop is nullable, so absence at
// any of them reads as "cannot compact" rather than as a shape to assume.
function supportsCompaction(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const management = (capabilities as Record<string, unknown>)[
    "context_management"
  ];
  if (typeof management !== "object" || management === null) return false;
  const compact = (management as Record<string, unknown>)[COMPACTION_ID];
  return (
    typeof compact === "object" &&
    compact !== null &&
    (compact as Record<string, unknown>)["supported"] === true
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

// Normalises one page of Anthropic's /v1/models into the neutral shape the
// settings form renders.
export function describeAnthropicModels(data: unknown): ModelOption[] {
  if (typeof data !== "object" || data === null) return [];
  const entries = (data as Record<string, unknown>)["data"];
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((raw): ModelOption[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string") return [];

    const levels = effortLevels(entry["capabilities"]);
    return [
      {
        id,
        reasoning:
          levels.length === 0
            ? null
            : {
                label: "Effort",
                levels,
                defaultLevel: resolveDefault(levels, ANTHROPIC_DEFAULT_EFFORT),
                canDisable: canDisableThinking(entry["capabilities"]),
              },
        maxOutputTokens: positiveNumber(entry["max_tokens"]),
        maxInputTokens: positiveNumber(entry["max_input_tokens"]),
        compaction: supportsCompaction(entry["capabilities"]),
      },
    ];
  });
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly config: ResolvedLLMConfig;
  private readonly opts?: ProviderCallOptions;
  private messages: BetaMessageParam[] = [];

  constructor(
    system: string,
    config: ResolvedLLMConfig,
    apiKey?: string,
    opts?: ProviderCallOptions,
  ) {
    this.system = system;
    this.config = config;
    this.opts = opts;
    // The DB is the only runtime source for the key: an env var is read once at
    // first boot to seed that row, never again, so there is no second source here.
    this.client = new Anthropic({
      apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: config.requestTimeoutMs,
      // Retries live in withLLMRetries alone. Leaving the SDK's own on would
      // multiply with that ladder, turning one logical call into a dozen.
      maxRetries: 0,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    let response: BetaMessage;
    try {
      // Stream and accumulate via finalMessage() so a large response can't trip the single-read
      // request timeout; the returned Message is identical to a non-streamed one.
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.config.maxOutputTokens,
          // A single cache breakpoint on the system block caches the stable
          // system + tools prefix, which is identical on every loop turn.
          system: [
            {
              type: "text",
              text: this.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          ...this.thinkingParams(),
          ...this.compactionParams(),
          // ToolSchema is structurally compatible with Anthropic.Beta.BetaTool.
          tools: tools as Anthropic.Beta.BetaTool[],
          messages: this.messagesWithCacheBreakpoint(),
        },
        { signal },
      );
      if (onDelta) {
        stream.on("text", (delta) => onDelta({ kind: "text", text: delta }));
        stream.on("thinking", (delta) =>
          onDelta({ kind: "thinking", text: delta }),
        );
      }
      response = await stream.finalMessage();
    } catch (err) {
      // A refused request carries no usage, so turns is the only size to report.
      const scale = { model: this.model, turns: this.messages.length };
      if (err instanceof Anthropic.APIError) {
        logger.error(
          { ...scale, status: err.status, err },
          "Anthropic request failed",
        );
      } else {
        logger.error({ ...scale, err }, "Anthropic request failed");
      }
      throw err;
    }

    /* At info: a run that dies on context is diagnosable without reproducing it.
       The top-level counts exclude compaction, which is billed as its own
       iteration, so summarising a turn would otherwise read as a cheap one. */
    const compactionTokens = (response.usage.iterations ?? [])
      .filter((it) => it.type === "compaction")
      .reduce((sum, it) => sum + it.input_tokens + it.output_tokens, 0);
    logger.info(
      {
        model: this.model,
        turns: this.messages.length,
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens,
        cacheWrite: response.usage.cache_creation_input_tokens,
        ...(compactionTokens > 0 && { compaction: compactionTokens }),
      },
      "Anthropic usage",
    );

    this.messages.push({ role: "assistant", content: response.content });

    const toolUses: ToolUse[] = response.content
      .filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        name: b.name,
        // Anthropic types tool input as unknown; the loop narrows per tool.
        input: b.input as Record<string, unknown>,
      }));

    const textBlock = response.content.find(
      (b): b is Anthropic.Beta.BetaTextBlock => b.type === "text",
    );
    const text = textBlock?.text ?? "";

    return {
      stopReason: mapStopReason(response.stop_reason),
      toolUses,
      text,
    };
  }

  // Thinking and effort are separate controls here: `thinking` decides whether
  // the model reasons at all, `output_config.effort` how hard it works.
  private thinkingParams(): ThinkingParams {
    // A model that publishes no ladder is sent neither param: there is nothing
    // to ask it for, and a guess would be a 400.
    if (this.config.reasoning === null) return {};
    const effort = toEffort(this.config.reasoningLevel);
    // A model that cannot be told to stop reasoning keeps its normal config;
    // the caller's small token budget is the remaining brake.
    if (this.opts?.reasoning !== "off" || !this.config.reasoning.canDisable) {
      // display "summarized" is the opt-in that makes reasoning visible: it
      // defaults to "omitted" on current models, which streams no thinking
      // deltas at all. The raw chain of thought is never returned either way.
      return {
        thinking: { type: "adaptive", display: "summarized" },
        ...effortParam(effort),
      };
    }
    return {
      thinking: { type: "disabled" },
      // Opus 5 rejects disabled thinking at xhigh or max with a 400, so the
      // effort steps down to the strongest level that accepts it.
      ...effortParam(effort === "xhigh" || effort === "max" ? "high" : effort),
    };
  }

  /* Both facts come from the catalog, so a model that stated neither is sent
     nothing and keeps today's behaviour: the run ends on the provider's refusal. */
  private compactionParams(): CompactionParams {
    const window = this.config.maxInputTokens;
    if (!this.config.compaction || window === null) return {};
    return {
      betas: [COMPACTION_BETA],
      context_management: {
        edits: [
          {
            type: COMPACTION_ID,
            trigger: {
              type: "input_tokens",
              value: Math.max(
                MIN_COMPACTION_TRIGGER,
                Math.round(window * COMPACTION_TRIGGER_RATIO),
              ),
            },
          },
        ],
      },
    };
  }

  // Rolling cache breakpoint on the conversation tail so growing history caches incrementally;
  // marks only the final tool_result in-flight, so persisted history stays clean.
  private messagesWithCacheBreakpoint(): BetaMessageParam[] {
    const lastIdx = this.messages.length - 1;
    const last = this.messages[lastIdx];
    if (!last || typeof last.content === "string") return this.messages;

    const blocks = last.content;
    const tailIdx = blocks.length - 1;
    const tail = blocks[tailIdx];
    if (tail?.type !== "tool_result") return this.messages;

    const marked: Anthropic.Beta.BetaToolResultBlockParam = {
      ...tail,
      cache_control: { type: "ephemeral" },
    };
    return [
      ...this.messages.slice(0, lastIdx),
      { ...last, content: [...blocks.slice(0, tailIdx), marked] },
    ];
  }

  appendToolResults(results: ToolResult[]): void {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error && { is_error: true }),
      })),
    });
  }

  appendUserMessage(message: string): void {
    this.messages.push({ role: "user", content: message });
  }

  seed(history: ProviderMessage[]): void {
    // A message this dialect wrote is replayed byte-exact: thinking blocks carry
    // signatures Anthropic rejects if altered. Anything else is rebuilt from parts,
    // which loses the reasoning and keeps the conversation.
    const replayed = history.map((m) =>
      m.native?.dialect === DIALECT
        ? (m.native.message as BetaMessageParam)
        : toNativeMessage(m),
    );
    this.messages = this.config.compaction
      ? replayed
      : replayed.flatMap((m) => {
          const stripped = withoutCompaction(m);
          return stripped === null ? [] : [stripped];
        });
  }

  snapshot(): ProviderMessage[] {
    return this.messages.map((m) => {
      const parts = toParts(m);
      return {
        // Anthropic messages are only user/assistant; coerce for the neutral type.
        role: m.role === "assistant" ? "assistant" : "user",
        content: messagePartsToText(parts),
        parts,
        native: { dialect: DIALECT, message: m },
      };
    });
  }
}

/* The turns a compaction block stood for are still in the transcript, so
   dropping it costs the model a shortcut and not the conversation. Null when it
   was the only block: an empty content array is itself rejected. */
function withoutCompaction(m: BetaMessageParam): BetaMessageParam | null {
  if (typeof m.content === "string") return m;
  const kept = m.content.filter((b) => b.type !== "compaction");
  if (kept.length === m.content.length) return m;
  return kept.length === 0 ? null : { ...m, content: kept };
}

function toParts(m: BetaMessageParam): MessagePart[] {
  if (typeof m.content === "string") {
    return m.content ? [{ type: "text", text: m.content }] : [];
  }
  const parts: MessagePart[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    // Null content is a compaction that produced no usable summary. It rides on
    // in `native` as the no-op the server treats it as, but it is never drawn:
    // a line saying the context was summarised where none was is a lie.
    else if (b.type === "compaction") {
      if (b.content != null) parts.push({ type: "compaction" });
    } else if (b.type === "thinking")
      parts.push({ type: "reasoning", text: b.thinking });
    else if (b.type === "tool_use")
      parts.push({
        type: "tool_call",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    else if (b.type === "tool_result")
      parts.push({
        type: "tool_result",
        toolCallId: b.tool_use_id,
        output:
          typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        ...(b.is_error && { isError: true }),
      });
  }
  return parts;
}

// Rebuild from parts for a message another dialect wrote. Reasoning and
// compaction are dropped: a thinking block without its signature is rejected,
// and a compaction block belongs to a conversation the other provider never had.
function toNativeMessage(m: ProviderMessage): BetaMessageParam {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const part of m.parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool_call") {
      blocks.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      });
    } else if (part.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.output,
        ...(part.isError && { is_error: true }),
      });
    }
  }
  return blocks.length > 0
    ? { role: m.role, content: blocks }
    : { role: m.role, content: m.content };
}

function mapStopReason(
  reason: Anthropic.Beta.BetaStopReason | null,
): ChatResponse["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    // end_turn, stop_sequence, pause_turn, null all mean "the model is done
    // for now with no tool call" - the loop treats that as a normal stop.
    default:
      return "end_turn";
  }
}
