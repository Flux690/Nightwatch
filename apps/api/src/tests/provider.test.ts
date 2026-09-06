import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { MessagePart, ResolvedLLMConfig } from "@nightwarden/shared";
import { requestOptions } from "../llm/factory.js";
import { SdkProvider } from "../llm/provider.js";
import type { ProviderMessage, StreamDelta, ToolSchema } from "../llm/types.js";

/* The vendor's own double, so what the adapter is tested against cannot drift
   from the interface a provider package implements. Turns are consumed in
   order and the last one repeats. */
function fakeModel(
  ...turns: LanguageModelV4StreamPart[][]
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const chunks = turns[call++] ?? turns[turns.length - 1] ?? [];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
}

function finish(
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "other",
): LanguageModelV4StreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, reasoning: undefined },
      totalTokens: 2,
    },
  };
}

function text(id: string, ...deltas: string[]): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    ...deltas.map((delta): LanguageModelV4StreamPart => ({
      type: "text-delta",
      id,
      delta,
    })),
    { type: "text-end", id },
  ];
}

const NO_TOOLS: ToolSchema[] = [];

function provider(model: MockLanguageModelV4): SdkProvider {
  return new SdkProvider(model, "SYSTEM", {
    maxOutputTokens: 4096,
    providerOptions: {},
  });
}

// The prompt of the last call, which is what a real provider would have read.
function lastPrompt(model: MockLanguageModelV4): LanguageModelV4Message[] {
  return model.doStreamCalls[model.doStreamCalls.length - 1]!.prompt;
}

describe("what the run sends a model, and what it makes of the answer", () => {
  it("marks the system prompt for caching, since a run repeats it every turn", async () => {
    const model = fakeModel([...text("t", "Hi"), finish("stop")]);
    const p = provider(model);
    p.start("first");

    await p.chat(NO_TOOLS);

    expect(lastPrompt(model)[0]).toEqual({
      role: "system",
      content: "SYSTEM",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("names the tool a result answers, which only the call that made it says", async () => {
    const model = fakeModel([
      {
        type: "tool-call",
        toolCallId: "tu-1",
        toolName: "GetDockerLogs",
        input: '{"target":"web-01"}',
      },
      finish("tool-calls"),
    ]);
    const p = provider(model);
    p.start("first");
    const turn = await p.chat(NO_TOOLS);

    expect(turn.stopReason).toBe("tool_use");
    expect(turn.toolUses).toEqual([
      {
        toolCallId: "tu-1",
        name: "GetDockerLogs",
        input: { target: "web-01" },
      },
    ]);

    p.appendToolResults([{ toolCallId: "tu-1", content: "lines" }]);
    await p.chat(NO_TOOLS);

    expect(lastPrompt(model).at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu-1",
          toolName: "GetDockerLogs",
          output: { type: "text", value: "lines" },
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    });
  });

  // The flag is the wire's own, so a provider that words failure differently
  // still reads this result as one.
  it("sends a failed result as an error rather than as prose", async () => {
    const model = fakeModel([...text("t", "ok"), finish("stop")]);
    const p = provider(model);
    p.start("first");
    p.appendToolResults([
      { toolCallId: "tu-1", content: "it broke", isError: true },
    ]);

    await p.chat(NO_TOOLS);

    const tool = lastPrompt(model).find((m) => m.role === "tool");
    expect(tool?.content[0]).toMatchObject({
      output: { type: "error-text", value: "it broke" },
    });
  });

  /* An alert that arrives with a turn's results is a user turn of its own here,
     because a tool message carries no room for it. */
  it("splits results and text into the two messages they are", async () => {
    const model = fakeModel([...text("t", "ok"), finish("stop")]);
    const p = provider(model);
    p.seed([
      {
        role: "user",
        content: "",
        parts: [
          { type: "tool_result", toolCallId: "tu-1", output: "lines" },
          { type: "text", text: "another alert fired" },
        ],
      },
    ]);

    await p.chat(NO_TOOLS);

    expect(
      lastPrompt(model)
        .slice(1)
        .map((m) => m.role),
    ).toEqual(["tool", "user"]);
  });

  it("carries a thinking signature back on the block it belongs to", async () => {
    const model = fakeModel([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "weighing it" },
      {
        type: "reasoning-delta",
        id: "r",
        delta: "",
        providerMetadata: { anthropic: { signature: "sig-abc" } },
      },
      { type: "reasoning-end", id: "r" },
      ...text("t", "Done."),
      finish("stop"),
    ]);
    const p = provider(model);
    p.start("first");

    const turn = await p.chat(NO_TOOLS);

    expect(turn.parts[0]).toEqual({
      type: "reasoning",
      text: "weighing it",
      providerOptions: { anthropic: { signature: "sig-abc" } },
    });

    // Replayed with the signature, without which the provider rejects the block.
    await p.chat(NO_TOOLS);
    const assistant = lastPrompt(model).find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toEqual({
      type: "reasoning",
      text: "weighing it",
      providerOptions: { anthropic: { signature: "sig-abc" } },
    });
  });

  it("takes a summary back as the block it arrived as, not as prose", async () => {
    const model = fakeModel([
      {
        type: "text-start",
        id: "c",
        providerMetadata: { anthropic: { type: "compaction" } },
      },
      { type: "text-delta", id: "c", delta: "what came before" },
      { type: "text-end", id: "c" },
      finish("stop"),
    ]);
    const p = provider(model);
    p.start("first");

    const turn = await p.chat(NO_TOOLS);
    expect(turn.parts).toEqual([
      { type: "compaction", text: "what came before" },
    ]);

    await p.chat(NO_TOOLS);
    const assistant = lastPrompt(model).find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toEqual({
      type: "text",
      text: "what came before",
      providerOptions: { anthropic: { type: "compaction" } },
    });
  });

  // A block with no text said nothing, and a compaction that produced no summary
  // is the no-op the provider treats it as.
  it("keeps no empty block on the record", async () => {
    const model = fakeModel([
      ...text("t"),
      {
        type: "text-start",
        id: "c",
        providerMetadata: { anthropic: { type: "compaction" } },
      },
      { type: "text-end", id: "c" },
      finish("stop"),
    ]);
    const p = provider(model);
    p.start("first");

    expect((await p.chat(NO_TOOLS)).parts).toEqual([]);
  });

  it("streams reasoning and visible text as the two kinds they are", async () => {
    const model = fakeModel([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "thinking" },
      ...text("t", "answer"),
      finish("stop"),
    ]);
    const seen: StreamDelta[] = [];
    const p = provider(model);
    p.start("first");

    await p.chat(NO_TOOLS, (d) => seen.push(d));

    expect(seen).toEqual([
      { kind: "thinking", text: "thinking" },
      { kind: "text", text: "answer" },
    ]);
  });

  it.each([
    ["content-filter", "refusal"],
    ["length", "max_tokens"],
    ["tool-calls", "tool_use"],
    ["stop", "end_turn"],
    ["other", "end_turn"],
  ] as const)("reads a %s finish as %s", async (unified, expected) => {
    const model = fakeModel([...text("t", "x"), finish(unified)]);
    const p = provider(model);
    p.start("first");

    expect((await p.chat(NO_TOOLS)).stopReason).toBe(expected);
  });

  /* Per-tool validation refuses empty arguments with a correction the model can
     act on, which is a better answer than killing the run. */
  it("survives tool arguments that are not JSON", async () => {
    const model = fakeModel([
      {
        type: "tool-call",
        toolCallId: "tu-1",
        toolName: "GetDockerLogs",
        input: "{not json",
      },
      finish("tool-calls"),
    ]);
    const p = provider(model);
    p.start("first");

    expect((await p.chat(NO_TOOLS)).toolUses[0]?.input).toEqual({});
  });

  // Returning what arrived would read as a turn the model finished.
  it("throws when the stream fails part way rather than returning a short turn", async () => {
    const model = fakeModel([
      ...text("t", "half a th"),
      { type: "error", error: new Error("upstream died") },
    ]);
    const p = provider(model);
    p.start("first");

    await expect(p.chat(NO_TOOLS)).rejects.toThrow("upstream died");
  });

  // The report turn offers one tool and cannot come back as prose.
  it("forces the named tool when one is required", async () => {
    const model = fakeModel([...text("t", "x"), finish("stop")]);
    const p = provider(model);
    p.start("first");

    await p.chat(NO_TOOLS, undefined, undefined, "SubmitInvestigationReport");

    expect(model.doStreamCalls[0]?.toolChoice).toEqual({
      type: "tool",
      toolName: "SubmitInvestigationReport",
    });
  });

  it("resumes from a stored transcript, which is all a seed carries", async () => {
    const model = fakeModel([...text("t", "x"), finish("stop")]);
    const parts: MessagePart[] = [
      { type: "text", text: "look at web-01" },
      {
        type: "tool_call",
        toolCallId: "tu-1",
        name: "ListDockerServices",
        input: {},
      },
    ];
    const history: ProviderMessage[] = [
      { role: "user", content: "look at web-01", parts: [parts[0]!] },
      { role: "assistant", content: "", parts: [parts[1]!] },
      {
        role: "user",
        content: "one service",
        parts: [
          { type: "tool_result", toolCallId: "tu-1", output: "one service" },
        ],
      },
    ];
    const p = provider(model);
    p.seed(history);

    await p.chat(NO_TOOLS);

    expect(lastPrompt(model).map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });
});

describe("what each provider is asked for", () => {
  function config(over: Partial<ResolvedLLMConfig>): ResolvedLLMConfig {
    return {
      provider: "anthropic",
      model: "a-model",
      maxOutputTokens: 4096,
      maxInputTokens: null,
      compaction: false,
      maxRetries: 0,
      requestTimeoutMs: 1000,
      reasoningLevel: "high",
      reasoning: {
        levels: [
          { value: "high", label: "High" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
      },
      ...over,
    };
  }

  it("keeps thinking on for Anthropic whatever rung is picked", () => {
    expect(requestOptions(config({ reasoningLevel: null }))).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    });
  });

  it.each([
    [
      "anthropic",
      {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          effort: "high",
        },
      },
    ],
    ["openai", { openai: { reasoningEffort: "high" } }],
    ["openrouter", { openrouter: { reasoning: { effort: "high" } } }],
  ] as const)("sends %s the rung in its own wording", (provider, expected) => {
    expect(requestOptions(config({ provider }))).toEqual(expected);
  });

  // A four-word title needs the cheapest rung, not the one a run was configured for.
  it("asks for the weakest rung the model publishes on a minimal call", () => {
    expect(
      requestOptions(config({ provider: "openai" }), {
        minimalReasoning: true,
      }),
    ).toEqual({
      openai: { reasoningEffort: "low" },
    });
  });

  it("derives the compaction trigger from the model's own window", () => {
    const options = requestOptions(
      config({ compaction: true, maxInputTokens: 200_000 }),
    );

    expect(options["anthropic"]?.["contextManagement"]).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 150_000 },
        },
      ],
    });
  });

  // The API refuses a lower trigger, so a small window compacts at the floor.
  it("floors the trigger rather than sending a value the API refuses", () => {
    const options = requestOptions(
      config({ compaction: true, maxInputTokens: 32_000 }),
    );

    expect(options["anthropic"]?.["contextManagement"]).toMatchObject({
      edits: [{ trigger: { value: 50_000 } }],
    });
  });

  /* Both facts come from the catalogue, so a model that stated neither is sent
     nothing and the run ends on the provider's own refusal instead. */
  it.each([
    [
      "a model that cannot compact",
      { compaction: false, maxInputTokens: 200_000 },
    ],
    ["a window nobody published", { compaction: true, maxInputTokens: null }],
  ] as const)("asks for no compaction for %s", (_name, over) => {
    expect(
      requestOptions(config(over))["anthropic"]?.["contextManagement"],
    ).toBeUndefined();
  });
});
