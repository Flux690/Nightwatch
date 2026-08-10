import type { DispatchedToolResult } from "../agent/tools/types.js";

// The dispatcher renders every result to the string the model reads, so a test
// asserting shape parses it back. The assertion narrows JSON.parse's own `any`.
export function parsedContent<T>(result: DispatchedToolResult): T {
  return JSON.parse(result.content) as T;
}
