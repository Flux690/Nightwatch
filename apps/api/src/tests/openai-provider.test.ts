import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "@nightwatch/shared";

// Mocked stream object returned by client.chat.completions.stream().
const mockFinalChatCompletion = vi.fn();
const mockStream = {
  on: vi.fn().mockReturnThis(),
  finalChatCompletion: mockFinalChatCompletion,
};
const mockCompletionsStream = vi.fn().mockReturnValue(mockStream);

vi.mock("openai", () => ({
  default: class MockOpenAI {
    readonly chat = {
      completions: { stream: mockCompletionsStream },
    };
    static APIError = class extends Error {
      status = 0;
      code = "";
    };
  },
}));

import { OpenAIProvider } from "../llm/openai.js";

const BASE_CONFIG: AgentConfig = {
  provider: "openai",
  model: "gpt-4o",
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

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.on.mockReturnThis();
    mockCompletionsStream.mockReturnValue(mockStream);
    provider = new OpenAIProvider("You are Nightwatch.", BASE_CONFIG);
    provider.start("CPU spike detected.");
  });

  it("returns free-form text with no toolUses when the model ends its turn", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Root cause: the webapp container was OOM-killed.",
            tool_calls: undefined,
          },
        },
      ],
    });

    const response = await provider.chat([READ_TOOL]);

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolUses).toHaveLength(0);
    expect(response.text).toContain("OOM-killed");
  });

  it("passes every tool through unchanged and sends no response_format", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "done",
            tool_calls: undefined,
          },
        },
      ],
    });

    await provider.chat([READ_TOOL]);

    const callArgs = mockCompletionsStream.mock.calls[0]?.[0] as {
      tools: Array<{ function: { name: string } }>;
      response_format?: unknown;
    };
    expect((callArgs.tools ?? []).map((t) => t.function.name)).toEqual([
      "get_container_list",
    ]);
    expect(callArgs.response_format).toBeUndefined();
  });

  it("passes through real tool calls unchanged when the model uses tools", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call-123",
                function: {
                  name: "get_container_list",
                  arguments: JSON.stringify({ environment: "docker" }),
                },
              },
            ],
          },
        },
      ],
    });

    const response = await provider.chat([READ_TOOL]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("get_container_list");
    expect(response.toolUses[0].id).toBe("call-123");
  });
});
