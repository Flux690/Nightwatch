import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ReasoningDescriptor,
  ResolvedLLMConfig,
} from "@nightwarden/shared";

const mockFinalMessage = vi.fn();
const mockAnthropicOn = vi.fn().mockReturnThis();
const mockAnthropicStream = {
  on: mockAnthropicOn,
  finalMessage: mockFinalMessage,
};
const mockMessagesStream = vi.fn().mockReturnValue(mockAnthropicStream);

// Compaction lives on the beta namespace, so every call goes through it - the
// betas array is what decides whether a header is sent, not which client is used.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    readonly beta = { messages: { stream: mockMessagesStream } };
    static APIError = class extends Error {
      status = 0;
    };
  },
}));

import { AnthropicProvider } from "../llm/anthropic.js";

const LADDER: ReasoningDescriptor = {
  label: "Effort",
  levels: [
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
  defaultLevel: "high",
  canDisable: true,
};

const BASE_CONFIG: ResolvedLLMConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxOutputTokens: 4096,
  maxInputTokens: null,
  compaction: false,
  maxRetries: 0,
  requestTimeoutMs: 10_000,
  reasoningLevel: null,
  reasoning: LADDER,
};

// A model that advertises compaction and a 200k window, which is the case
// Anthropic's own 150,000 default was calibrated for.
const COMPACTING_CONFIG: ResolvedLLMConfig = {
  ...BASE_CONFIG,
  maxInputTokens: 200_000,
  compaction: true,
};

const READ_TOOL = {
  name: "ListDockerServices",
  description: "List containers.",
  input_schema: {
    type: "object" as const,
    properties: { environment: { type: "string" } },
    required: ["environment"],
  },
};

function makeUsage() {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicOn.mockReturnThis();
    mockMessagesStream.mockReturnValue(mockAnthropicStream);
    provider = new AnthropicProvider("You are NightWarden.", BASE_CONFIG);
    provider.start("CPU spike detected.");
  });

  it("returns free-form text with no toolUses when the model ends its turn", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "Root cause: the webapp container was OOM-killed.",
          citations: null,
        },
      ],
      usage: makeUsage(),
    });

    const response = await provider.chat([READ_TOOL]);

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolUses).toHaveLength(0);
    expect(response.text).toContain("OOM-killed");
  });

  it("passes every tool through unchanged and sends no structured-output config", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done", citations: null }],
      usage: makeUsage(),
    });

    await provider.chat([READ_TOOL]);

    const callArgs = mockMessagesStream.mock.calls[0]?.[0] as {
      tools: Array<{ name: string }>;
      output_config?: unknown;
    };
    expect((callArgs.tools ?? []).map((t) => t.name)).toEqual([
      "ListDockerServices",
    ]);
    expect(callArgs.output_config).toBeUndefined();
  });

  describe("thinking and effort", () => {
    // Anthropic keeps these on two separate params: `thinking` decides whether
    // the model reasons, `output_config.effort` how hard it works.
    async function sentParams(
      config: ResolvedLLMConfig,
      opts?: { reasoning: "off" },
    ): Promise<{ thinking?: unknown; output_config?: { effort?: string } }> {
      mockFinalMessage.mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done", citations: null }],
        usage: makeUsage(),
      });
      const p = new AnthropicProvider("sys", config, undefined, opts);
      p.start("go");
      await p.chat([]);
      return mockMessagesStream.mock.calls[0]?.[0] as {
        thinking?: unknown;
        output_config?: { effort?: string };
      };
    }

    it("asks for summarized thinking, without which current models stream no thinking text at all", async () => {
      const params = await sentParams(BASE_CONFIG);

      expect(params.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
    });

    it("sends the chosen effort under output_config, which is where Anthropic takes it", async () => {
      const params = await sentParams({
        ...BASE_CONFIG,
        reasoningLevel: "xhigh",
      });

      expect(params.output_config).toEqual({ effort: "xhigh" });
    });

    it("sends no effort at all when the user has picked no level", async () => {
      const params = await sentParams(BASE_CONFIG);

      expect(params.output_config).toBeUndefined();
    });

    it("disables thinking for a reasoning-off call, which omitting the param would not do", async () => {
      const params = await sentParams(BASE_CONFIG, { reasoning: "off" });

      expect(params.thinking).toEqual({ type: "disabled" });
    });

    it("steps effort down to high when disabling thinking, which Opus 5 rejects at xhigh or max", async () => {
      const params = await sentParams(
        { ...BASE_CONFIG, reasoningLevel: "max" },
        { reasoning: "off" },
      );

      expect(params.thinking).toEqual({ type: "disabled" });
      expect(params.output_config).toEqual({ effort: "high" });
    });

    it("keeps thinking on for a reasoning-off call when the model refuses to be switched off", async () => {
      const params = await sentParams(
        {
          ...BASE_CONFIG,
          reasoning: { ...LADDER, canDisable: false },
        },
        { reasoning: "off" },
      );

      expect(params.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
    });
  });

  describe("compaction", () => {
    async function sentFor(
      config: ResolvedLLMConfig,
      seed?: Parameters<AnthropicProvider["seed"]>[0],
    ): Promise<{
      betas?: string[];
      context_management?: {
        edits: Array<{
          type: string;
          trigger?: { type: string; value: number };
        }>;
      };
      messages: Array<{ role: string; content: unknown }>;
    }> {
      mockFinalMessage.mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done", citations: null }],
        usage: makeUsage(),
      });
      /* Captured as the call is made, not read back afterwards: the params hold
         the provider's own message array by reference, and the turn's reply is
         pushed onto it before the await returns. */
      let captured: Record<string, unknown> = {};
      mockMessagesStream.mockImplementationOnce(
        (params: { messages: unknown[] }) => {
          captured = { ...params, messages: [...params.messages] };
          return mockAnthropicStream;
        },
      );
      const p = new AnthropicProvider("sys", config);
      if (seed) p.seed(seed);
      else p.start("go");
      await p.chat([]);
      return captured as never;
    }

    // One turn holding a compaction block, as the API returned it: the summary
    // and the opaque metadata that must survive the round trip byte for byte.
    function compactedTurn() {
      return [
        {
          role: "assistant" as const,
          content: "earlier work",
          parts: [],
          native: {
            dialect: "anthropic-messages" as const,
            message: {
              role: "assistant",
              content: [
                {
                  type: "compaction",
                  content: "Summary of the investigation so far.",
                  encrypted_content: "opaque-blob",
                },
                { type: "text", text: "earlier work" },
              ],
            },
          },
        },
      ];
    }

    it("asks for compaction at a trigger derived from the model's own window", async () => {
      const sent = await sentFor(COMPACTING_CONFIG);

      expect(sent.betas).toEqual(["compact-2026-01-12"]);
      expect(sent.context_management).toEqual({
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 150_000 },
          },
        ],
      });
    });

    it("floors the trigger at the API minimum rather than sending a value it refuses", async () => {
      const sent = await sentFor({
        ...COMPACTING_CONFIG,
        maxInputTokens: 32_000,
      });

      expect(sent.context_management?.edits[0]?.trigger?.value).toBe(50_000);
    });

    it("sends nothing at all for a model whose catalog does not advertise it", async () => {
      const sent = await sentFor(BASE_CONFIG);

      expect(sent.betas).toBeUndefined();
      expect(sent.context_management).toBeUndefined();
    });

    it("sends no trigger when the catalog published no window, since the one we would invent is not ours", async () => {
      const sent = await sentFor({
        ...COMPACTING_CONFIG,
        maxInputTokens: null,
      });

      expect(sent.betas).toBeUndefined();
      expect(sent.context_management).toBeUndefined();
    });

    it("replays a stored compaction block verbatim, which the API requires to keep the summary", async () => {
      const sent = await sentFor(COMPACTING_CONFIG, compactedTurn());

      const blocks = sent.messages[0]?.content as Array<
        Record<string, unknown>
      >;
      expect(blocks[0]).toEqual({
        type: "compaction",
        content: "Summary of the investigation so far.",
        encrypted_content: "opaque-blob",
      });
    });

    /* The block summarises turns this transcript still holds in full, so dropping
       it costs the model a shortcut and nothing else - and a model that cannot
       accept one must never be sent it. */
    it("drops a stored compaction block when the model can no longer compact", async () => {
      const sent = await sentFor(BASE_CONFIG, compactedTurn());

      const blocks = sent.messages[0]?.content as Array<
        Record<string, unknown>
      >;
      expect(blocks.map((b) => b["type"])).toEqual(["text"]);
      expect(sent.betas).toBeUndefined();
    });

    /* Anthropic rejects a message with an empty content array, so stripping the
       only block out of one has to remove the message rather than empty it. The
       turn answered no tool call, so nothing below it is left dangling. */
    it("drops a turn that held nothing but the summary, rather than sending an empty message", async () => {
      const sent = await sentFor(BASE_CONFIG, [
        {
          role: "assistant",
          content: "",
          parts: [],
          native: {
            dialect: "anthropic-messages",
            message: {
              role: "assistant",
              content: [
                {
                  type: "compaction",
                  content: "summary",
                  encrypted_content: null,
                },
              ],
            },
          },
        },
        {
          role: "user",
          content: "and then?",
          parts: [{ type: "text", text: "and then?" }],
        },
      ]);

      expect(sent.messages).toHaveLength(1);
      expect(sent.messages[0]?.role).toBe("user");
    });

    it("draws nothing for a compaction that produced no summary, which summarised nothing", async () => {
      mockFinalMessage.mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [
          { type: "compaction", content: null, encrypted_content: "opaque" },
          { type: "text", text: "carrying on", citations: null },
        ],
        usage: makeUsage(),
      });
      const p = new AnthropicProvider("sys", COMPACTING_CONFIG);
      p.start("go");
      await p.chat([]);

      // Still replayed, since the server treats it as a no-op and expects it back.
      const last = p.snapshot().at(-1);
      expect(last?.parts.map((part) => part.type)).toEqual(["text"]);
      const native = last?.native?.message as {
        content: Array<{ type: string }>;
      };
      expect(native.content.map((b) => b.type)).toEqual(["compaction", "text"]);
    });

    it("records a compaction in the snapshot, so the transcript can say it happened", async () => {
      mockFinalMessage.mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [
          {
            type: "compaction",
            content: "Summary of the investigation so far.",
            encrypted_content: "opaque-blob",
          },
          { type: "text", text: "carrying on", citations: null },
        ],
        usage: makeUsage(),
      });
      const p = new AnthropicProvider("sys", COMPACTING_CONFIG);
      p.start("go");
      await p.chat([]);

      const last = p.snapshot().at(-1);
      expect(last?.parts.map((part) => part.type)).toEqual([
        "compaction",
        "text",
      ]);
    });
  });

  it("passes through real tool_use blocks unchanged when the model uses tools", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "ListDockerServices",
          input: {},
        },
      ],
      usage: makeUsage(),
    });

    const response = await provider.chat([READ_TOOL]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("ListDockerServices");
    expect(response.toolUses[0].id).toBe("tu-1");
  });
});
