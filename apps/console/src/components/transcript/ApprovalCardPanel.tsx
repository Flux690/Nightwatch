import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ApprovalCardItem } from "./types.js";
import { ToolCard } from "./toolPresentation.js";
import { InterruptCard } from "./InterruptCard.js";

/* The only bordered block in the stream, which is what makes it unmissable
   without a colour wash. Approvals habituate when every request looks the same,
   so the weight lives here and ordinary tool calls are borderless rows. */

// Shared by both halves of the exchange so neither can be styled as the louder one.
const EXCHANGE_LABEL_CLASS = "text-sm text-ink-subtle";

function inputString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// The exact argv, never a paraphrase: what the user reads has to be what
// runs, or the approval is theatre.
function commandOf(input: Record<string, unknown>): string | null {
  const command = input["command"];
  if (Array.isArray(command))
    return command.map((part) => String(part)).join(" ");
  return typeof command === "string" ? command : null;
}

function serviceOf(input: Record<string, unknown>): string | null {
  const target = input["target"];
  if (typeof target === "string") {
    const parts = target.split("/");
    return parts[parts.length - 1] ?? target;
  }
  return inputString(input, "server");
}

/* The agent's own grading of the call. The three levels the schema asks for read
   as a sentence; anything else it wrote is shown as the note it is rather than
   glued into a template, and nothing at all reads as nothing. */
const RISK_SENTENCE: Record<string, string> = {
  low: "The agent calls this low risk",
  medium: "The agent calls this medium risk",
  high: "The agent calls this high risk",
};

function riskLineOf(risk: string | undefined): string | null {
  const said = risk?.trim() ?? "";
  if (said === "") return null;
  return RISK_SENTENCE[said.toLowerCase()] ?? said;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

// A verb and its object beat "Approve": a generic label is the one users learn
// to click without reading. Derived from the tool, so it cannot overstate.
function actionLabel(toolName: string, input: Record<string, unknown>): string {
  const service = serviceOf(input);
  switch (toolName) {
    case "RestartDockerService":
    case "RestartK8sWorkload":
      return service ? `Restart ${service}` : "Restart service";
    case "DockerBash":
    case "K8sBash":
    case "Bash":
      return "Run this command";
    default:
      return `Run ${toolName}`;
  }
}

export function ApprovalCardPanel({
  item,
  submitting = false,
  onResolve,
}: {
  item: ApprovalCardItem;
  // A decision already sent and awaiting its reply. Belongs to the component,
  // not the transcript: it describes this browser, not the session.
  submitting?: boolean;
  onResolve?: (action: "approve" | "reject", reason?: string) => void;
}): React.JSX.Element {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const state = item.state;
  const resolved = state.phase === "resolved";
  const { input } = item;
  const command = commandOf(input);
  const service = serviceOf(input);
  // The agent's own words for why, which is the one part of this card it is
  // entitled to author. Required on every write tool, so it is absent only on a
  // row written before that was true.
  const why = inputString(input, "reason");
  const riskLine = riskLineOf(item.risk);

  return (
    <>
      <InterruptCard data-testid="approval-card" resolved={resolved}>
        {!resolved && (
          <p className="text-sm font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            Needs your approval
          </p>
        )}

        <p className="text-base font-semibold">
          {actionLabel(item.toolName, input)}
        </p>

        {/* Labelled, and at full body weight, because this one sentence is what
            the decision turns on. Its label pairs with "Your reason" below, so a
            rejection reads as the answer to it rather than as a separate act. */}
        {why !== null && (
          <div className="flex flex-col gap-1">
            <p className={EXCHANGE_LABEL_CLASS}>Agent&rsquo;s reason</p>
            <p className="text-sm leading-relaxed text-foreground">{why}</p>
          </div>
        )}

        {command !== null && (
          <pre className="m-0 overflow-x-auto rounded-md border border-border px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap">
            <span className="text-ink-subtle select-none">$ </span>
            {command}
          </pre>
        )}

        {/* Counted from this investigation's own transcript, never authored.
            Repeating a fix is rarely fixing it, and 3am is exactly when that
            pattern is easiest to miss. */}
        {item.priorRuns !== undefined && !resolved && (
          <p className="text-sm text-warning">
            {ordinal(item.priorRuns + 1)} time in this investigation.
          </p>
        )}

        {/* Facts about the call, plus the agent's own risk assessment. Its
            opinion, labelled as such, sitting beside the command that lets you
            judge it yourself. */}
        <div className="flex flex-wrap gap-4 text-sm text-ink-subtle">
          <span className="font-mono">{item.toolName}</span>
          {service !== null && <span className="font-mono">{service}</span>}
          {riskLine !== null && <span>{riskLine}</span>}
        </div>

        {state.phase === "resolved" ? (
          <p className="text-sm" data-testid="approval-resolution">
            {state.decision === "approved" ? "Approved" : "Rejected"}
          </p>
        ) : rejecting ? (
          // The comment is fed back to the agent as this call's result, so it
          // redirects the work rather than only recording a refusal. Optional,
          // and said to be optional: a blank rejection is still a decision.
          <div className="flex flex-col gap-2">
            <p className={EXCHANGE_LABEL_CLASS}>Your reason (optional)</p>
            <Textarea
              autoFocus
              rows={2}
              aria-label="Your reason for rejecting this"
              placeholder="Tell the agent what is wrong with this. It reads your reason and tries a different approach."
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={submitting}
                onClick={() =>
                  onResolve?.("reject", reason.trim() || undefined)
                }
              >
                Send rejection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={submitting}
              onClick={() => onResolve?.("approve")}
            >
              {actionLabel(item.toolName, input)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          </div>
        )}
      </InterruptCard>
      {state.phase === "resolved" && (
        <ToolCard
          item={{
            kind: "tool_card",
            toolUseId: item.toolUseId,
            toolName: item.toolName,
            input: item.input,
            state:
              state.result === undefined
                ? { phase: "running" }
                : { phase: "complete", result: state.result },
          }}
        />
      )}
    </>
  );
}
