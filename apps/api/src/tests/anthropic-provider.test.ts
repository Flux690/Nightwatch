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

const FINAL_RESPONSE_TOOL = {
  name: "final_response",
  description: "Finish the investigation.",
  strict: true as const,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
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

function makeUsage() {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

describe("AnthropicProvider structured output", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAnthropicOn.mockReturnThis();
    mockMessagesStream.mockReturnValue(mockAnthropicStream);
    provider = new AnthropicProvider("You are Nightwatch.", BASE_CONFIG);
    provider.start("CPU spike detected.");
  });

  it("synthesizes a final_response ToolUse when model returns structured JSON (stop_reason: end_turn, text block)", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify(VALID_STRUCTURED_OUTPUT),
          citations: null,
        },
      ],
      usage: makeUsage(),
    });

    const response = await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("final_response");
    expect(response.toolUses[0].input).toMatchObject(VALID_STRUCTURED_OUTPUT);
    expect(typeof response.toolUses[0].id).toBe("string");
    expect(response.toolUses[0].id.length).toBeGreaterThan(0);
  });

  it("strips final_response from the tools list and sets output_config.format", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "{}", citations: null }],
      usage: makeUsage(),
    });

    await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    const callArgs = mockMessagesStream.mock.calls[0]?.[0] as {
      tools: Array<{ name: string }>;
      output_config: {
        format: { type: string; schema: Record<string, unknown> };
      };
    };

    const toolNames = (callArgs.tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("final_response");
    expect(toolNames).toContain("get_container_list");
    expect(callArgs.output_config).toMatchObject({
      format: { type: "json_schema" },
    });
    expect(callArgs.output_config.format.schema).toBeDefined();
  });

  it("returns empty toolUses when structured output content is not valid JSON", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json at all", citations: null }],
      usage: makeUsage(),
    });

    const response = await provider.chat([FINAL_RESPONSE_TOOL]);

    expect(response.toolUses).toHaveLength(0);
  });

  it("passes through real tool_use blocks unchanged when model uses tools mid-investigation", async () => {
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

    const response = await provider.chat([FINAL_RESPONSE_TOOL, OTHER_TOOL]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("get_container_list");
    expect(response.toolUses[0].id).toBe("tu-1");
  });

  it("synthesizes correctly when thinking blocks precede the JSON text block", async () => {
    mockFinalMessage.mockResolvedValueOnce({
      stop_reason: "end_turn",
      content: [
        {
          type: "thinking",
          thinking: "Let me reason about this...",
          signature: "",
        },
        {
          type: "text",
          text: JSON.stringify(VALID_STRUCTURED_OUTPUT),
          citations: null,
        },
      ],
      usage: makeUsage(),
    });

    const response = await provider.chat([FINAL_RESPONSE_TOOL]);

    expect(response.toolUses).toHaveLength(1);
    expect(response.toolUses[0].name).toBe("final_response");
    expect(response.toolUses[0].input).toMatchObject(VALID_STRUCTURED_OUTPUT);
  });
});
