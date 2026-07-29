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

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    readonly messages = { stream: mockMessagesStream };
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
  maxRetries: 0,
  requestTimeoutMs: 10_000,
  reasoningLevel: null,
  reasoning: LADDER,
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

    it("sends no effort at all when the operator has picked no level", async () => {
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
