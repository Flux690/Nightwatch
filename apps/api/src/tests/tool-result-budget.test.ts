import { describe, expect, it } from "vitest";
import { executeTool } from "../agent/tools/toolset.js";
import {
  ITEM_BUDGET_CHARS,
  fitWithinBudget,
} from "../agent/tools/result-budget.js";
import { MAX_TOOL_RESULT_CHARS } from "../llm/config.js";
import type { Tool, ToolDispatchContext } from "../agent/tools/types.js";

// The ceiling every tool result passes, and the rule the tools share for
// staying under it. Each tool's own wiring is asserted in its own seam.

const CTX: ToolDispatchContext = {
  toolCallCeilingMs: 30_000,
  sessionId: "budget-session",
  toolUseId: "tu-budget",
};

function toolReturning(content: unknown): Tool {
  return {
    schema: {
      name: "Oversized",
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    access: "read",
    on: "api",
    execute: () => Promise.resolve({ content }),
  };
}

describe("the ceiling on one tool result", () => {
  /* Slicing is the failure this exists to prevent: a cut JSON result parses as
     a smaller truth, and the model reads it as the whole answer. */
  it("refuses an oversized result whole, naming the size and the move", async () => {
    const lines = Array.from(
      { length: 4_000 },
      (_, i) => `2026-08-10T00:00:00Z connection refused to upstream ${i}`,
    );
    const result = await executeTool(toolReturning({ lines }), {}, CTX);

    expect(result.outcome).toBe("system");
    // Not one character of it: a prefix would read as the whole answer.
    expect(result.content).not.toContain("connection refused");
    expect(result.content).toContain("Oversized");
    expect(result.content).toContain(String(MAX_TOOL_RESULT_CHARS));
    expect(result.content).toMatch(/narrow the call/i);
  });
});

describe("fitting items into the budget", () => {
  it("keeps whole items, counts the rest, and reports what it spent", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      body: "y".repeat(1_000),
    }));

    const { kept, dropped, spent } = fitWithinBudget(items);

    expect(kept.length + dropped).toBe(items.length);
    expect(dropped).toBeGreaterThan(0);
    // Every kept item is the item, not a shortened version of it.
    for (const item of kept) expect(item.body.length).toBe(1_000);
    expect(kept).toEqual(items.slice(0, kept.length));
    // GetRecentChanges bounds its commits by what its pull requests spent, so a
    // wrong `spent` silently hands the second list a budget already used.
    expect(spent).toBe(JSON.stringify(kept).length - 2 - (kept.length - 1));
    expect(spent).toBeLessThanOrEqual(ITEM_BUDGET_CHARS);
  });
});
