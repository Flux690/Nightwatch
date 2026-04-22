import { gemini } from "./model";
import {
  Content,
  Part,
  ThinkingLevel,
  FunctionDeclaration,
  FunctionCallingConfigMode,
} from "@google/genai";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/helpers";
import { validateSchema } from "../utils/validateSchema";

export type AgentTool<T = unknown> = {
  declaration: FunctionDeclaration;
  handler: (args: T) => Promise<unknown>;
};

export type AgentRunConfig = {
  systemInstruction: string;
  initialUserMessage: string;
  tools: AgentTool[];
  conversationHistory?: Content[];
  responseSchema: any;
};

export async function runAgent<T>(
  config: AgentRunConfig,
): Promise<{ result: T; conversationHistory: Content[] }> {
  const {
    systemInstruction,
    initialUserMessage,
    tools,
    conversationHistory = [],
    responseSchema,
  } = config;

  const MAX_TOOL_ROUNDS = 20;

  const history: Content[] = [...conversationHistory];
  let userMessage: Part[] = [{ text: initialUserMessage }];
  let toolRounds = 0;

  while (true) {
    history.push({ role: "user", parts: userMessage });

    const response = await withRetry(() =>
      gemini.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: history,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
            includeThoughts: true,
          },
          tools:
            tools.length > 0
              ? [{ functionDeclarations: tools.map((t) => t.declaration) }]
              : undefined,
          toolConfig:
            tools.length > 0
              ? {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.AUTO,
                  },
                }
              : undefined,
        },
      }),
    );

    const modelContent = response.candidates?.[0]?.content;
    if (!modelContent?.parts) throw new Error("Empty model response");

    history.push(modelContent);

    if (response.functionCalls?.length) {
      const toolResults = await Promise.all(
        response.functionCalls.map(async (call) => {
          if (!call.name) {
            throw new Error("Function call missing name");
          }
          logger.tool(call.name, call.args);

          const tool = tools.find((t) => t.declaration.name === call.name);
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);

          const result = await tool.handler(call.args);
          return {
            functionResponse: {
              name: call.name,
              response: { result },
            },
          };
        }),
      );

      userMessage = toolResults as Part[];
      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        throw new Error(`Agent exceeded maximum tool rounds (${MAX_TOOL_ROUNDS})`);
      }
      continue;
    }

    const modelText = modelContent.parts.find((p) => p.text)?.text;
    if (modelText) {
      const parsed = tryParseJson<T>(modelText);
      if (parsed) {
        const validated = validateSchema<T>(responseSchema, parsed, "agent response");
        return { result: validated, conversationHistory: history };
      }
    }

    // Cleanup: ask for valid JSON
    history.push({
      role: "user",
      parts: [
        { text: "Provide your answer as valid JSON matching the schema." },
      ],
    });

    const cleanupResponse = await withRetry(() =>
      gemini.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: history,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema,
        },
      }),
    );

    const cleanupContent = cleanupResponse.candidates?.[0]?.content;
    const cleanJson = cleanupContent?.parts?.[0]?.text;

    if (!cleanJson || !cleanupContent) throw new Error("Cleanup phase failed");

    history.push(cleanupContent);

    return {
      result: JSON.parse(cleanJson) as T,
      conversationHistory: history,
    };
  }
}

function tryParseJson<T>(text: string): T | null {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as T;
  } catch {
    return null;
  }
}

/**
 * Clean conversation history for handoff between capabilities.
 * Keeps: user text, functionCall parts, functionResponse parts, final structured output.
 * Drops: thinking traces (thought: true), cleanup prompts.
 */
export function cleanHistory(history: Content[]): Content[] {
  const cleaned: Content[] = [];

  for (const entry of history) {
    // Drop user messages that are cleanup prompts
    if (entry.role === "user") {
      const isCleanupPrompt = entry.parts?.some(
        (p) =>
          p.text === "Provide your answer as valid JSON matching the schema.",
      );
      if (isCleanupPrompt) continue;
    }

    // Filter out thinking parts from model messages
    if (entry.role === "model" && entry.parts) {
      const filteredParts = entry.parts.filter(
        (p) => !(p as any).thought,
      );
      if (filteredParts.length === 0) continue;
      cleaned.push({ ...entry, parts: filteredParts });
      continue;
    }

    cleaned.push(entry);
  }

  return cleaned;
}
