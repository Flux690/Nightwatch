import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "@nightwatch/shared";

const VALID_STRUCTURED_OUTPUT = {
  rootCause: {
    summary: "High memory usage caused OOM kill.",
    evidence: ["dmesg: oom-kill process webapp"],
    contributingFactors: null,
  },
  recommendedAction: null,
  escalateIfRejected: false,
  investigationSteps: ["checked dmesg", "confirmed OOM"],
};

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

const FINAL_RESPONSE_TOOL = {
  name: "final_response",
  description: "Finish the investigation.",
  strict: true as const,
  input_schema: {
    type: "object" as const,
    properties: {
      rootCause: { type: "object", properties: {} },
      recommendedAction: {},
      escalateIfRejected: { type: "boolean" },
      investigationSteps: { type: "array", items: { type: "string" } },
    },
    required: [
      "rootCause",
      "recommendedAction",
      "escalateIfRejected",
      "investigationSteps",
    ],
    additionalProperties: false,
  },
};

const OTHER_TOOL = {
  name: "get_container_list",
  description: "List containers.",
  input_schema: {
    type: "object" as const,
    properties: { environment: { type: "string" } },
    required: ["environment"],
  },
};

describe("OpenAIProvider structured output", () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStream.on.mockReturnThis();
    mockCompletionsStream.mockReturnValue(mockStream);
    provider = new OpenAIProvider("You are Nightwatch.", BASE_CONFIG);
    provider.start("CPU spike detected.");
  });

  it("synthesizes a final_response ToolUse when model returns structured JSON (finish_reason: stop)", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(VALID_STRUCTURED_OUTPUT),
            tool_calls: undefined,
          },
        },
      ],
    });

    const response = await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("final_response");
    expect(response.toolUses[0].input).toMatchObject(VALID_STRUCTURED_OUTPUT);
    // id must be a non-empty string
    expect(typeof response.toolUses[0].id).toBe("string");
    expect(response.toolUses[0].id.length).toBeGreaterThan(0);
  });

  it("strips final_response from the tools list sent to the API and uses response_format instead", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "{}", tool_calls: undefined },
        },
      ],
    });

    await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    const callArgs = mockCompletionsStream.mock.calls[0]?.[0] as {
      tools: Array<{ function: { name: string } }>;
      response_format: { type: string; json_schema: { name: string } };
    };
    // final_response must not appear as a function tool
    const toolNames = (callArgs.tools ?? []).map((t) => t.function.name);
    expect(toolNames).not.toContain("final_response");
    expect(toolNames).toContain("get_container_list");
    // response_format must be set with the final_response schema
    expect(callArgs.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "final_response" },
    });
  });

  it("returns empty toolUses when structured output content is not valid JSON", async () => {
    mockFinalChatCompletion.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "not json at all",
            tool_calls: undefined,
          },
        },
      ],
    });

    const response = await provider.chat([FINAL_RESPONSE_TOOL]);

    // Invalid JSON → no synthesis → loop will escalate via empty toolUses check
    expect(response.toolUses).toHaveLength(0);
  });

  it("passes through real tool calls unchanged when model uses tools (not structured output)", async () => {
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

    const response = await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("get_container_list");
    expect(response.toolUses[0].id).toBe("call-123");
  });
});
