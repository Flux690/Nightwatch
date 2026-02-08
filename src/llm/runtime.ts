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

  const history: Content[] = [...conversationHistory];
  let userMessage: Part[] = [{ text: initialUserMessage }];

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
          if (call.name !== "ask_user") {
            logger.tool(call.name, call.args);
          }

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
      continue;
    }

    const modelText = modelContent.parts.find((p) => p.text)?.text;
    if (modelText) {
      const parsed = tryParseJson<T>(modelText);
      if (parsed) {
        return { result: parsed, conversationHistory: history };
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
