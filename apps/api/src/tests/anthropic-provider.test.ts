import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "@nightwatch/shared";

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

const BASE_CONFIG: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: "off",
  maxOutputTokens: 4096,
  maxRetries: 0,
  requestTimeoutMs: 10_000,
  maxToolCalls: 24,
  hardTimeoutMs: 300_000,
  toolTimeoutMs: 15_000,
};

const READ_TOOL = {
  name: "get_container_list",
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
    provider = new AnthropicProvider("You are Nightwatch.", BASE_CONFIG);
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
      "get_container_list",
    ]);
    expect(callArgs.output_config).toBeUndefined();
  });

  it("passes through real tool_use blocks unchanged when the model uses tools", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "get_container_list",
          input: { environment: "docker" },
        },
      ],
      usage: makeUsage(),
    });

    const response = await provider.chat([READ_TOOL]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("get_container_list");
    expect(response.toolUses[0].id).toBe("tu-1");
  });
});
