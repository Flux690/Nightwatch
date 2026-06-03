import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { db } from "../db/client.js";
import { sendCommand } from "../ws/router.js";
import { buildInitialContext } from "./context.js";
import {
  TOOL_SCHEMAS,
  PLATFORM_TOOLS,
  RUNNER_TOOLS,
  REQUIRES_APPROVAL,
} from "./tools.js";
import type {
  NormalizedAlert,
  ApprovalDecision,
  CommitInfo,
  GetRecentCommitsInput,
} from "@nightwatch/shared";

const MAX_TOOL_CALLS = 24;
const HARD_TIMEOUT_MS = 5 * 60_000;
const TOOL_TIMEOUT_MS = 15_000;
// Must be less than HARD_TIMEOUT_MS so approval can time out before the investigation does.
const APPROVAL_TIMEOUT_MS = 4 * 60_000;
const CLARIFICATION_TIMEOUT_MS = 90_000;

// Module-level bus — Phase 5 wires real Slack decisions into this
export const approvalBus = new EventEmitter();
approvalBus.setMaxListeners(100);

export function resolveApproval(decision: ApprovalDecision): void {
  approvalBus.emit(`decision:${decision.toolUseId}`, decision);
}

const InvestigationResultSchema = z.object({
  rootCause: z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()),
    contributingFactors: z.array(z.string()).optional(),
  }),
  recommendedAction: z
    .object({
      toolName: z.string(),
      targetContainer: z.string(),
      params: z.record(z.unknown()),
      rationale: z.string(),
      risk: z.enum(["low", "medium", "high"]),
      estimatedDowntimeSeconds: z.number(),
      followUp: z.string().optional(),
    })
    .nullable(),
  escalateIfRejected: z.boolean(),
  investigationSteps: z.array(z.string()),
});

const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"],
});

export async function runInvestigation(alert: NormalizedAlert): Promise<void> {
  const incidentId = `${alert.installationId}-${alert.sourceAlertId}-${Date.now()}`;
  console.log(`[loop] starting investigation ${incidentId}`);

  const { systemPrompt, firstUserMessage } = await buildInitialContext(alert);

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: firstUserMessage },
  ];

  let toolCallCount = 0;
  let clarificationsUsed = 0;
  const deadline = Date.now() + HARD_TIMEOUT_MS;

  while (toolCallCount < MAX_TOOL_CALLS && Date.now() < deadline) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOL_SCHEMAS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      await conclude(alert, incidentId, textBlock?.text ?? "");
      return;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      toolCallCount++;
      const input = block.input as Record<string, unknown>;

      // ── Platform tools: handled here on the API, runner not involved ────────
      if (PLATFORM_TOOLS.has(block.name)) {
        const result = await handlePlatformTool(
          block,
          input,
          incidentId,
          clarificationsUsed,
        );
        if (block.name === "request_clarification") clarificationsUsed++;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          ...result,
        });
        continue;
      }

      // ── Runner tools ─────────────────────────────────────────────────────────
      if (RUNNER_TOOLS.has(block.name)) {
        if (REQUIRES_APPROVAL.has(block.name)) {
          const decision = await requestApproval(alert, incidentId, block);

          if (decision.action === "reject") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Rejected by human reviewer. Do not retry this action.",
              is_error: true,
            });
            if (alert.severity === "critical") {
              await escalate(
                alert,
                incidentId,
                `Write action rejected: ${block.name}`,
              );
              return;
            }
            continue;
          }

          if (decision.action === "add_context") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Human added context: ${decision.contextMessage ?? "(no message)"}`,
            });
            continue;
          }
          // action === "approve" — fall through to sendCommand
        }

        try {
          const result = await sendCommand(
            alert.installationId,
            block.name,
            input,
            TOOL_TIMEOUT_MS,
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error executing ${block.name}: ${msg}`,
            is_error: true,
          });
        }
        continue;
      }

      // ── Unknown tool — configuration error, surface clearly ─────────────────
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Unknown tool "${block.name}". This is a platform configuration error — the tool exists in TOOL_SCHEMAS but has no routing entry. Do not retry.`,
        is_error: true,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  await escalate(
    alert,
    incidentId,
    `Exceeded ${MAX_TOOL_CALLS} tool calls or ${HARD_TIMEOUT_MS / 60_000}m timeout`,
  );
}

// ── Platform tool handlers ───────────────────────────────────────────────────

async function handlePlatformTool(
  block: Anthropic.Messages.ToolUseBlock,
  input: Record<string, unknown>,
  incidentId: string,
  clarificationsUsed: number,
): Promise<{ content: string; is_error?: true }> {
  if (block.name === "request_clarification") {
    if (clarificationsUsed >= 1) {
      return {
        content:
          "request_clarification already used once this investigation. Conclude with the evidence already gathered.",
        is_error: true,
      };
    }
    const question =
      (input["question"] as string | undefined) ?? "(no question)";
    const context = (input["context"] as string | undefined) ?? "";
    console.log(
      `[loop] clarification requested incidentId=${incidentId}: ${question}`,
    );
    // Phase 5: send to Slack and wait on approvalBus with CLARIFICATION_TIMEOUT_MS.
    // For now, return automated stub so Claude can continue rather than stalling.
    return {
      content: `Automated mode — no human available to answer "${question}". Context noted: ${context}. Continue with available evidence and conclude at best-effort confidence.`,
    };
  }

  if (block.name === "get_recent_commits") {
    try {
      const commits = await fetchGitHubCommits(
        input as unknown as GetRecentCommitsInput,
      );
      return { content: JSON.stringify(commits) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `GitHub fetch failed: ${msg}`, is_error: true };
    }
  }

  return {
    content: `No handler for platform tool "${block.name}".`,
    is_error: true,
  };
}

async function fetchGitHubCommits(
  input: GetRecentCommitsInput,
): Promise<{ commits: CommitInfo[] }> {
  const { repoOwner, repoName, branch = "main", limit = 10 } = input;
  const token = process.env["GITHUB_TOKEN"];

  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/commits?sha=${branch}&per_page=${limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nightwatch-api/2",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const raw = (await res.json()) as Array<Record<string, unknown>>;
  const commits: CommitInfo[] = raw.map((c) => {
    const commit = c["commit"] as Record<string, unknown>;
    const author = commit["author"] as Record<string, unknown>;
    const sha = String(c["sha"] ?? "");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      message: String(
        (commit["message"] as string | undefined)?.split("\n")[0] ?? "",
      ),
      author: String((author?.["name"] as string | undefined) ?? ""),
      timestamp: String((author?.["date"] as string | undefined) ?? ""),
      filesChanged: [],
      additions: 0,
      deletions: 0,
    };
  });

  return { commits };
}

// ── Approval gate ────────────────────────────────────────────────────────────

async function requestApproval(
  alert: NormalizedAlert,
  incidentId: string,
  block: Anthropic.Messages.ToolUseBlock,
): Promise<ApprovalDecision> {
  const approvalId = randomUUID();

  await db.approvalRequest.create({
    data: {
      id: approvalId,
      incidentId,
      installationId: alert.installationId,
      toolName: block.name,
      toolInput: block.input as Record<string, unknown>,
      toolUseId: block.id,
      status: "pending",
    },
  });

  // Phase 5 wires Slack here
  console.log(
    `[approval] PENDING — incidentId=${incidentId} tool=${block.name} id=${block.id}`,
    JSON.stringify(block.input, null, 2),
  );

  return new Promise<ApprovalDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      approvalBus.removeAllListeners(`decision:${block.id}`);
      reject(
        new Error(`Approval timed out after ${APPROVAL_TIMEOUT_MS / 60_000}m`),
      );
    }, APPROVAL_TIMEOUT_MS);

    approvalBus.once(`decision:${block.id}`, (decision: ApprovalDecision) => {
      clearTimeout(timer);
      void db.approvalRequest.update({
        where: { id: approvalId },
        data: {
          status:
            decision.action === "approve"
              ? "approved"
              : decision.action === "reject"
                ? "rejected"
                : "context_added",
          comment: decision.comment,
          resolvedAt: new Date(),
        },
      });
      resolve(decision);
    });
  });
}

// ── Conclude / escalate ──────────────────────────────────────────────────────

async function conclude(
  alert: NormalizedAlert,
  incidentId: string,
  rawText: string,
): Promise<void> {
  let parsed: unknown;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] ?? rawText);
  } catch {
    await escalate(
      alert,
      incidentId,
      `Could not parse result JSON: ${rawText.slice(0, 200)}`,
    );
    return;
  }

  const result = InvestigationResultSchema.safeParse(parsed);
  if (!result.success) {
    await escalate(
      alert,
      incidentId,
      `Result failed schema validation: ${result.error.message}`,
    );
    return;
  }

  console.log(
    `[loop] concluded incidentId=${incidentId} confidence=${result.data.rootCause.confidence} action=${result.data.recommendedAction?.toolName ?? "none"}`,
  );
}

async function escalate(
  alert: NormalizedAlert,
  incidentId: string,
  reason: string,
): Promise<void> {
  console.error(
    `[loop] ESCALATE incidentId=${incidentId} installation=${alert.installationId} reason=${reason}`,
  );
  // Phase 5: post escalation card to Slack
}

// Exposed for Phase 5 Slack webhook handler
export { CLARIFICATION_TIMEOUT_MS };
