// Public adapter contract. createProvider() returns Provider; callers in the
// investigation domain talk to LLMs only through this interface.
// Re-exported from types.ts where all supporting shapes (ToolSchema, etc.) live.
export type { LLMProvider as Provider } from "./types.js";
