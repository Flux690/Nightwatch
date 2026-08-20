import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TestProviders } from "./renderWithProviders.js";

import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import type {
  ToolOutcome,
  TranscriptItem,
} from "@/components/transcript/types";

function wrap(
  item: TranscriptItem,
  opts?: {
    onResolve?: (toolUseId: string, action: "approve" | "reject") => void;
    onAnswer?: (toolUseId: string, answer: string | string[]) => void;
    onRetryReport?: () => void;
  },
): void {
  render(
    <TestProviders>
      <div
        data-testid="transcript-column"
        style={{ maxWidth: 860, margin: "0 auto", padding: "0 16px" }}
      >
        <TranscriptItemRenderer
          item={item}
          onResolve={opts?.onResolve}
          onAnswer={opts?.onAnswer}
          onRetryReport={opts?.onRetryReport}
        />
      </div>
    </TestProviders>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TranscriptItemRenderer", () => {
  describe("agent_text — full-width markdown", () => {
    it("does not render raw HTML from agent text as DOM elements", () => {
      wrap({
        kind: "agent_text",
        id: "a3",
        text: "<script>alert(1)</script>",
        turn: 1,
      });

      expect(document.querySelector("script")).not.toBeInTheDocument();
    });
  });

  describe("a call awaiting approval", () => {
    const approvalItem: TranscriptItem = {
      kind: "tool_call",
      toolUseId: "tu-gate",
      toolName: "RestartDockerService",
      input: {
        service: { project: "web-01", service: "web-01" },
        reason: "The health check has failed six times in a row.",
        risk: "high",
      },
      state: { phase: "awaiting_human", gate: "approval" },
    };

    it("labels the action button with the verb, not a generic Approve", async () => {
      const onResolve = vi.fn();
      wrap(approvalItem, { onResolve });

      // A generic label is the one users learn to click without reading.
      expect(
        screen.queryByRole("button", { name: /^approve$/i }),
      ).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /restart/i }));

      expect(onResolve).toHaveBeenCalledWith("tu-gate", "approve", undefined);
    });

    it("shows the exact command for a shell tool", () => {
      wrap({
        ...approvalItem,
        toolName: "DockerBash",
        input: {
          target: "docker/encodr-prod/encodr/cache",
          command: ["redis-cli", "CONFIG", "SET", "maxmemory", "8gb"],
          reason: "writes are being rejected",
        },
      });

      // Verbatim argv: what the user reads has to be what runs.
      expect(
        screen.getByText(/redis-cli CONFIG SET maxmemory 8gb/),
      ).toBeInTheDocument();
      expect(screen.getByText(/writes are being rejected/)).toBeInTheDocument();
    });

    it("says how often this write already ran here, so a tired user sees the pattern", () => {
      wrap({ ...approvalItem, priorRuns: 3 });

      // Counted from this investigation's transcript: it informs the decision,
      // never overrides it.
      expect(
        screen.getByText(/4th time in this investigation/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /restart/i })).toBeEnabled();
    });

    it("says nothing when this is the first time", () => {
      wrap(approvalItem);

      expect(screen.queryByText(/time in this investigation/)).toBeNull();
    });

    it("sends a rejection reason so the agent learns why, as the answer to the agent's own", async () => {
      const onResolve = vi.fn();
      wrap(approvalItem, { onResolve });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /^reject$/i }));

      // Two halves of one exchange: the agent states why it is asking, the
      // user answers in the same shape, and the answer is optional.
      expect(screen.getByText(/agent.s reason/i)).toBeInTheDocument();
      expect(
        screen.getByText(/the health check has failed six times/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/your reason \(optional\)/i)).toBeInTheDocument();

      await user.type(
        screen.getByRole("textbox", { name: /your reason for rejecting/i }),
        "restarting drops the cache",
      );
      await user.click(screen.getByRole("button", { name: /send rejection/i }));

      expect(onResolve).toHaveBeenCalledWith(
        "tu-gate",
        "reject",
        "restarting drops the cache",
      );
    });

    it("allows a bare rejection with no reason typed", async () => {
      const onResolve = vi.fn();
      wrap(approvalItem, { onResolve });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /^reject$/i }));
      await user.click(screen.getByRole("button", { name: /send rejection/i }));

      expect(onResolve).toHaveBeenCalledWith("tu-gate", "reject", undefined);
    });
  });

  describe("a call awaiting an answer", () => {
    const clarInput = {
      question: "Which service first?",
      options: [
        { label: "nginx", description: "web server" },
        { label: "postgres", description: "database" },
      ],
    };
    const clarItem: TranscriptItem = {
      kind: "tool_call",
      toolUseId: "tu-clar",
      toolName: "AskUserQuestion",
      input: clarInput,
      state: { phase: "awaiting_human", gate: "clarification" },
    };

    it("calls onAnswer with the selected radio once Submit is clicked", async () => {
      const onAnswer = vi.fn();
      wrap(clarItem, { onAnswer });

      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: /^nginx$/i }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(onAnswer).toHaveBeenCalledWith("tu-clar", "nginx");
    });

    it("multiSelect: accumulates checkbox selection and posts all on Submit", async () => {
      const onAnswer = vi.fn();
      wrap(
        { ...clarItem, input: { ...clarInput, multiSelect: true } },
        { onAnswer },
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: /^nginx$/i }));
      await user.click(screen.getByRole("checkbox", { name: /^postgres$/i }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(onAnswer).toHaveBeenCalledWith("tu-clar", ["nginx", "postgres"]);
    });

    it("reveals a free-text input when Other is selected and submits its text", async () => {
      const onAnswer = vi.fn();
      wrap(clarItem, { onAnswer });

      const user = userEvent.setup();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

      await user.click(screen.getByRole("radio", { name: /^other$/i }));
      const textbox = screen.getByRole("textbox");
      await user.type(textbox, "Both, but nginx first");
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(onAnswer).toHaveBeenCalledWith("tu-clar", "Both, but nginx first");
    });

    it("does not submit an empty Other answer", async () => {
      const onAnswer = vi.fn();
      wrap(clarItem, { onAnswer });

      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: /^other$/i }));

      expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
      expect(onAnswer).not.toHaveBeenCalled();
    });

    /* The tool requires a description on every option and the card used to
       drop all of them, leaving the reader the label alone to choose by. */
    it("shows what choosing each answer would mean", () => {
      wrap(clarItem);

      expect(screen.getByText("web server")).toBeInTheDocument();
      expect(screen.getByText("database")).toBeInTheDocument();
    });

    // A printed number a keyboard cannot press is a promise not kept.
    it("selects by the number printed beside the option, and submits on Enter", async () => {
      const onAnswer = vi.fn();
      const user = userEvent.setup();
      wrap(clarItem, { onAnswer });

      await user.keyboard("2");
      expect(screen.getByRole("radio", { name: /^postgres$/i })).toBeChecked();

      await user.keyboard("{Enter}");
      expect(onAnswer).toHaveBeenCalledWith("tu-clar", "postgres");
    });
  });

  describe("continue_card", () => {
    const continueItem = {
      kind: "continue_card" as const,
      toolUseId: "continue-uuid-1",
      state: { phase: "awaiting_human" as const },
    };

    it("calls onResolve with 'approve' when Continue is clicked", async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn();
      wrap(continueItem, { onResolve });

      await user.click(screen.getByRole("button", { name: /^continue$/i }));

      expect(onResolve).toHaveBeenCalledWith("continue-uuid-1", "approve");
    });

    it("calls onResolve with 'reject' when Cancel is clicked", async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn();
      wrap(continueItem, { onResolve });

      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(onResolve).toHaveBeenCalledWith("continue-uuid-1", "reject");
    });
  });

  describe("report_card", () => {
    const card = (phase: "building" | "ready" | "failed"): TranscriptItem => ({
      kind: "report_card",
      id: "report",
      state: { phase },
    });

    it("says the report is being written while the turn is in flight", () => {
      wrap(card("building"));

      expect(screen.getByTestId("report-card")).toHaveAttribute(
        "data-phase",
        "building",
      );
      expect(
        screen.getByText(/writing the investigation report/i),
      ).toBeInTheDocument();
    });

    /* Nothing opens on its own: a report that arrives over the message being
       read is the page moving under the reader. */
    it("waits to be opened rather than opening itself", async () => {
      const user = userEvent.setup();
      const opened = vi.fn();
      window.addEventListener("nw:open-report", opened);
      wrap(card("ready"));

      expect(opened).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: /open report/i }));
      expect(opened).toHaveBeenCalled();
      window.removeEventListener("nw:open-report", opened);
    });

    it("offers another attempt when the report was never written", async () => {
      const user = userEvent.setup();
      const onRetryReport = vi.fn();
      wrap(card("failed"), { onRetryReport });

      expect(screen.getByText(/report was not written/i)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /try again/i }));
      expect(onRetryReport).toHaveBeenCalled();
    });
  });

  /* Both names are the API's, so a rename there silently changes what the
     transcript shows. Pinned here because that is exactly how the last one
     went unnoticed. */
  describe("the report tools", () => {
    it("draws nothing for the submission the report card already announces", () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-report",
        toolName: "SubmitInvestigationReport",
        input: { headline: "Pool exhausted" },
        state: { phase: "complete", result: "recorded" },
      });
      expect(
        screen.queryByText(/SubmitInvestigationReport/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/recorded/)).not.toBeInTheDocument();
    });

    it("draws a recorded hypothesis, which is a step the reader can follow", () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-hypo",
        toolName: "RecordHypothesis",
        input: { statement: "The pool was exhausted" },
        state: { phase: "complete", result: "recorded" },
      });
      expect(screen.getByText(/RecordHypothesis/)).toBeInTheDocument();
    });
  });

  describe("repo tool cards", () => {
    const DIFF_RESULT = {
      path: "src/app.ts",
      hunks: [
        {
          lines: [
            {
              type: "removed",
              oldLineNumber: 1,
              newLineNumber: null,
              content: "const a = 1;",
            },
            {
              type: "added",
              oldLineNumber: null,
              newLineNumber: 1,
              content: "const a = 42;",
            },
          ],
        },
      ],
    };

    it("renders Edit results as a colored diff card", () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-1",
        toolName: "Edit",
        input: { path: "src/app.ts" },
        state: { phase: "complete", result: DIFF_RESULT },
      });

      expect(screen.getByTestId("diff-card")).toBeInTheDocument();
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("const a = 42;")).toBeInTheDocument();
      expect(screen.getByText("const a = 1;")).toBeInTheDocument();
      // No raw unified-diff artifacts leak into the rendered card.
      expect(screen.queryByText(/@@/)).not.toBeInTheDocument();
    });

    it("parses the persisted JSON-string form of a diff result too", () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-2",
        toolName: "Write",
        input: { path: "src/app.ts" },
        state: { phase: "complete", result: JSON.stringify(DIFF_RESULT) },
      });

      expect(screen.getByTestId("diff-card")).toBeInTheDocument();
      expect(screen.getByText("const a = 42;")).toBeInTheDocument();
    });

    it("renders OpenPullRequest results as a PR card with the GitHub link", () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-4",
        toolName: "OpenPullRequest",
        input: { title: "Fix the leak" },
        state: {
          phase: "complete",
          result: {
            action: "created",
            number: 42,
            url: "https://github.com/acme/api/pull/42",
            draft: true,
            message: "Created draft PR #42.",
          },
        },
      });

      expect(screen.getByTestId("pr-card")).toBeInTheDocument();
      expect(screen.getByText("Pull request #42")).toBeInTheDocument();
      expect(screen.getByText("Draft")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /view on github/i }),
      ).toHaveAttribute("href", "https://github.com/acme/api/pull/42");
      expect(screen.getByText("Created draft PR #42.")).toBeInTheDocument();
    });
  });

  describe("output disclosure", () => {
    it("shows an unknown tool's first line as the finding and the rest on expand", async () => {
      wrap({
        kind: "tool_call",
        toolUseId: "tu-5",
        toolName: "SomeToolWeDoNotRender",
        input: { target: "docker/api/api" },
        state: { phase: "complete", result: "cpu 0.91\nmem 0.44" },
      });

      // The row carries the answer; the remainder stays folded away.
      expect(screen.getByText(/cpu 0.91/)).toBeInTheDocument();
      expect(screen.queryByText(/mem 0.44/)).not.toBeInTheDocument();

      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: /SomeToolWeDoNotRender/ }));
      expect(screen.getByText(/mem 0.44/)).toBeInTheDocument();
    });

    it("caps a long shell result and reveals the rest on demand", async () => {
      // Twelve lines against a body cap of eight, so the cap is exercised
      // rather than merely configured.
      const output = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join(
        "\n",
      );
      wrap({
        kind: "tool_call",
        toolUseId: "tu-6",
        toolName: "Bash",
        input: { command: "ls" },
        state: { phase: "complete", result: { exitCode: 0, output } },
      });

      const user = userEvent.setup();
      // Exit status is the finding, so the row reports it without expanding.
      expect(screen.getByText(/exit 0/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Bash/ }));
      expect(screen.getByText(/line-1/)).toBeInTheDocument();
      expect(screen.queryByText(/line-12/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /show all 12/i }));
      expect(screen.getByText(/line-12/)).toBeInTheDocument();
    });
  });

  describe("outcome classes", () => {
    function finding(
      outcome: ToolOutcome | undefined,
      result: unknown,
    ): HTMLElement {
      wrap({
        kind: "tool_call",
        toolUseId: `tu-${outcome ?? "ok"}`,
        toolName: "Read",
        input: { path: "docker-compose.yml" },
        state: {
          phase: "complete",
          result,
          ...(outcome !== undefined && { outcome }),
        },
      });
      // The finding is the row's third span: name, target, then the answer.
      return screen.getByRole("button", { name: /Read/ })
        .children[2] as HTMLElement;
    }

    it("reads a missing file as ordinary muted text, not as a failure", () => {
      const cell = finding(
        "expected_miss",
        "File not found in the repository: docker-compose.yml.",
      );
      expect(cell).toHaveClass("text-muted-foreground");
      expect(cell.textContent).toContain("File not found");
      expect(cell.textContent).not.toContain("Failed");
    });

    it("tells a permission failure apart from a crashed tool by word and colour", () => {
      const denied = finding("permission", "GitHub rejected the token.");
      expect(denied.textContent).toContain("Permission denied");
      expect(denied).toHaveClass("text-wait");

      cleanup();
      const crashed = finding("system", "Error executing Read: boom");
      expect(crashed.textContent).toContain("Failed");
      expect(crashed).toHaveClass("text-fail");
    });

    it("says so when only some runners in a fan-out answered", () => {
      const cell = finding("partial", JSON.stringify({ byRunner: [] }));
      expect(cell.textContent).toContain("Some runners failed");
      expect(cell).not.toHaveClass("text-fail");
    });
  });

  describe("error_text", () => {
    it("renders a provider failure as NightWarden's notice, not as the agent talking", () => {
      wrap({
        kind: "error_text",
        id: "err-1",
        text: "The provider rate-limited the request (HTTP 429).",
      });

      const notice = screen.getByTestId("error-notice");
      expect(notice).toHaveTextContent("The run stopped");
      expect(notice).toHaveTextContent("rate-limited");
      // An agent message is prose in the flow; this is not one.
      expect(notice.querySelector(".prose")).toBeNull();
    });
  });
  describe("compaction", () => {
    it("says the context was summarised and that the record is untouched", () => {
      wrap({ kind: "compaction", id: "assistant-4-0" });

      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent("Context summarised");
      /* The reader's actual question on seeing this: did the evidence go? It did
         not - the model forgot, the transcript did not, and a compacted tool
         result is still citable in the report. */
      expect(notice).toHaveTextContent("stays in the record");
    });
  });

  describe("reveal from the report", () => {
    it("marks the named tool row without opening it, leaving the others untouched", async () => {
      const { revealToolCall } =
        await import("@/components/transcript/revealToolCall");

      render(
        <>
          <TranscriptItemRenderer
            item={{
              kind: "tool_call",
              toolUseId: "tu-logs",
              toolName: "GetDockerLogs",
              input: { target: "docker/encodr/cache" },
              state: {
                phase: "complete",
                result: JSON.stringify({
                  lines: ["OOM command not allowed"],
                  scannedLines: 200,
                }),
              },
            }}
          />
          <TranscriptItemRenderer
            item={{
              kind: "tool_call",
              toolUseId: "tu-stats",
              toolName: "GetDockerStats",
              input: { target: "docker/encodr/cache" },
              state: {
                phase: "complete",
                result: JSON.stringify({ cpuPercent: 0.35 }),
              },
            }}
          />
        </>,
      );

      const [logs, stats] = screen.getAllByTestId("tool-call");
      expect(logs!.querySelector("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      act(() => revealToolCall("tu-logs"));

      // The named row is marked and stays shut: the reader has already read the
      // output under the claim and came here for the steps around it, which
      // expanding would push off screen. The neighbour is untouched.
      await waitFor(() => {
        expect(logs).toHaveAttribute("data-revealed");
      });
      expect(logs!.querySelector("button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(stats).not.toHaveAttribute("data-revealed");
    });
  });
});
