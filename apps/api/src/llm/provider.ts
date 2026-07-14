// Public adapter contract: callers in the investigation domain talk to LLMs only through
// this interface. Re-exported from types.ts where the supporting shapes live.
export type { LLMProvider as Provider } from "./types.js";
