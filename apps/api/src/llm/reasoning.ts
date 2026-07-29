import type { ReasoningLevel } from "@nightwarden/shared";

// Shared by both adapters so neither has to import the other. Which value is
// preferred is each provider's own policy; only the fallback mechanic is common.
export function resolveDefault(
  levels: readonly ReasoningLevel[],
  preferred: string,
): string {
  const match = levels.find((l) => l.value === preferred);
  return match?.value ?? levels[0]?.value ?? preferred;
}
