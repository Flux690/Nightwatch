import { z } from "zod";
import { describe, expect, it } from "vitest";
import { processToolUses } from "../agent/turn.js";
import { logger } from "../logger.js";
import type { OfferedToolset } from "../agent/tools/toolset.js";
import type { ToolName } from "@nightwarden/shared";
import type { Tool } from "../agent/tools/types.js";
import type { ToolUse } from "../llm/types.js";

// A turn's calls are answered in the order the model emitted them, and the ones
// that contend for nothing go out together.

const EXEC = { sessionId: "turn-session", toolCallCeilingMs: 30_000 };

// Records when it entered and left, which is what tells a batch from a queue.
function tracked(
  name: string,
  effect: "read" | "write",
  ms: number,
  log: string[],
): Tool {
  return {
    schema: {
      name: name as ToolName,
      description: "",
      input_schema: { type: "object", properties: {} },
    },
    input: z.object({}),
    effect,
    policy: "auto",
    citable: true,
    renderAs: "text",
    on: "api",
    execute: async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
      return { content: name };
    },
  };
}

const call = (name: string): ToolUse => ({
  toolCallId: `tu-${name}`,
  name,
  input: {},
});

function offering(...tools: Tool[]): OfferedToolset {
  return { tools, elicitations: [] };
}

async function run(offered: OfferedToolset, names: string[]) {
  return await processToolUses({
    toolUses: names.map(call),
    offered,
    sessionId: EXEC.sessionId,
    execCtx: EXEC,
    log: logger,
    alreadyRefused: new Map(),
  });
}

describe("how a turn's tool calls are executed", () => {
  it("reads a turn asked for together rather than one after the next", async () => {
    const log: string[] = [];
    const offered = offering(
      tracked("A", "read", 40, log),
      tracked("B", "read", 40, log),
      tracked("C", "read", 40, log),
    );

    const started = Date.now();
    const { toolResults } = await run(offered, ["A", "B", "C"]);
    const elapsed = Date.now() - started;

    // All three enter before any leaves, which a sequential walk cannot produce.
    expect(log.slice(0, 3)).toEqual(["A:start", "B:start", "C:start"]);
    expect(elapsed).toBeLessThan(110);
    // Answered in the order they were asked for, whatever the timing did.
    expect(toolResults.map((r) => r.toolCallId)).toEqual([
      "tu-A",
      "tu-B",
      "tu-C",
    ]);
  });

  /* The order the model emitted is the order it reasoned in, so a write is
     never overtaken by a read asked for after it. */
  it("keeps a write between the reads around it", async () => {
    const log: string[] = [];
    const offered = offering(
      tracked("before", "read", 30, log),
      tracked("write", "write", 5, log),
      tracked("after", "read", 30, log),
    );

    const { toolResults } = await run(offered, ["before", "write", "after"]);

    expect(log).toEqual([
      "before:start",
      "before:end",
      "write:start",
      "write:end",
      "after:start",
      "after:end",
    ]);
    expect(toolResults.map((r) => r.toolCallId)).toEqual([
      "tu-before",
      "tu-write",
      "tu-after",
    ]);
  });

  // The second is refused where it was asked, so every call still gets an answer.
  it("suspends on the first gated call and refuses a second inline", async () => {
    const log: string[] = [];
    const offered = offering(
      tracked("read", "read", 1, log),
      { ...tracked("gateA", "write", 1, log), policy: "approve" },
      { ...tracked("gateB", "write", 1, log), policy: "approve" },
    );

    const { toolResults, gated } = await run(offered, [
      "gateA",
      "read",
      "gateB",
    ]);

    expect(gated?.tool.toolCallId).toBe("tu-gateA");
    expect(log).not.toContain("gateA:start");
    expect(toolResults.map((r) => r.toolCallId)).toEqual([
      "tu-read",
      "tu-gateB",
    ]);
    expect(toolResults[1]?.isError).toBe(true);
  });
});
