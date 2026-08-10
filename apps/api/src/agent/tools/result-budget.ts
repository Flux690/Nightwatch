import { MAX_TOOL_RESULT_CHARS } from "../../llm/config.js";

// Items share a budget under the whole-result ceiling, leaving room for the
// window, labels and notes wrapped around them.
export const ITEM_BUDGET_CHARS = Math.floor(MAX_TOOL_RESULT_CHARS * 0.8);

// Whole items until the budget runs out, because half a series draws a shape
// that never happened. `spent` lets one list's cost bound the next one's budget.
export function fitWithinBudget<T>(
  items: readonly T[],
  budget = ITEM_BUDGET_CHARS,
): { kept: T[]; dropped: number; spent: number } {
  const kept: T[] = [];
  let spent = 0;
  for (const item of items) {
    const cost = JSON.stringify(item).length;
    if (spent + cost > budget) break;
    spent += cost;
    kept.push(item);
  }
  return { kept, dropped: items.length - kept.length, spent };
}
