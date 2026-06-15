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

// Build a stream mock that captures event listeners by name and can fire them.
// Used by tests that need to simulate chunk events (e.g. reasoning_details).
function buildCapturingStream(completionResponse: unknown) {
  const listeners: Record<string, (data: unknown) => void> = {};
  const stream = {
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      listeners[event] = cb;
      return stream;
    }),
    finalChatCompletion: vi.fn(async () => {
      listeners["chunk"]?.({
        choices: [{ delta: { reasoning_details: [] } }],
      });
      return completionResponse;
    }),
    emit: (event: string, data: unknown) => listeners[event]?.(data),
  };
  return stream;
}

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

  describe("OpenRouter reasoning_details", () => {
    const FINISH_RESPONSE = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Postgres container OOM-killed.",
            tool_calls: undefined,
          },
        },
      ],
    };

    it("emits thinking deltas for reasoning.text and reasoning.summary entries", async () => {
      const stream = buildCapturingStream(FINISH_RESPONSE);
      stream.finalChatCompletion.mockImplementationOnce(async () => {
        stream.emit("chunk", {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: "reasoning.text", text: "step 1: check logs" },
                  { type: "reasoning.summary", text: "identified the issue" },
                ],
              },
            },
          ],
        });
        return FINISH_RESPONSE;
      });
      mockCompletionsStream.mockReturnValueOnce(stream);

      const onDelta = vi.fn();
      await provider.chat([READ_TOOL], onDelta);

      expect(onDelta).toHaveBeenCalledWith({
        kind: "thinking",
        text: "step 1: check logs",
      });
      expect(onDelta).toHaveBeenCalledWith({
        kind: "thinking",
        text: "identified the issue",
      });
    });

    it("skips reasoning.encrypted entries and emits nothing for them", async () => {
      const stream = buildCapturingStream(FINISH_RESPONSE);
      stream.finalChatCompletion.mockImplementationOnce(async () => {
        stream.emit("chunk", {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: "reasoning.encrypted", data: "base64encryptedblob" },
                  { type: "reasoning.text", text: "visible reasoning" },
                ],
              },
            },
          ],
        });
        return FINISH_RESPONSE;
      });
      mockCompletionsStream.mockReturnValueOnce(stream);

      const onDelta = vi.fn();
      await provider.chat([READ_TOOL], onDelta);

      const thinkingCalls = onDelta.mock.calls.filter(
        (c) => (c[0] as { kind: string }).kind === "thinking",
      );
      expect(thinkingCalls).toHaveLength(1);
      expect(thinkingCalls[0][0]).toEqual({
        kind: "thinking",
        text: "visible reasoning",
      });
    });

    it("emits no thinking deltas when reasoning_details is absent", async () => {
      mockFinalChatCompletion.mockResolvedValueOnce(FINISH_RESPONSE);

      const onDelta = vi.fn();
      await provider.chat([READ_TOOL], onDelta);

      const thinkingCalls = onDelta.mock.calls.filter(
        (c) => (c[0] as { kind: string }).kind === "thinking",
      );
      expect(thinkingCalls).toHaveLength(0);
    });

    it("visible content still arrives as kind:text alongside reasoning", async () => {
      const stream = buildCapturingStream(FINISH_RESPONSE);
      stream.finalChatCompletion.mockImplementationOnce(async () => {
        stream.emit("content", "some text delta");
        stream.emit("chunk", {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: "reasoning.text", text: "internal thought" },
                ],
              },
            },
          ],
        });
        return FINISH_RESPONSE;
      });
      mockCompletionsStream.mockReturnValueOnce(stream);

      const onDelta = vi.fn();
      await provider.chat([READ_TOOL], onDelta);

      expect(onDelta).toHaveBeenCalledWith({
        kind: "text",
        text: "some text delta",
      });
      expect(onDelta).toHaveBeenCalledWith({
        kind: "thinking",
        text: "internal thought",
      });
    });
  });
});
