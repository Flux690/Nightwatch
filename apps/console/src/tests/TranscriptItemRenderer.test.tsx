import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TestProviders } from "./renderWithProviders.js";

import { TranscriptItemRenderer } from "@/components/transcript/TranscriptItemRenderer";
import type { TranscriptItem } from "@/components/transcript/types";

function wrap(
  item: TranscriptItem,
  opts?: {
    onResolve?: (toolUseId: string, action: "approve" | "reject") => void;
    onAnswer?: (toolUseId: string, answer: string | string[]) => void;
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
      wrap({ kind: "agent_text", id: "a3", text: "<script>alert(1)</script>" });

      expect(document.querySelector("script")).not.toBeInTheDocument();
    });
  });


  describe("approval_card", () => {
    const approvalItem: TranscriptItem = {
      kind: "approval_card",
      toolUseId: "tu-gate",
      toolName: "RestartService",
      input: {
        service: { provider: "docker", project: "web-01", service: "web-01" },
      },
      result: null,
      risk: "high",
    };

    it("calls onResolve with approve when Approve is clicked", async () => {
      const onResolve = vi.fn();
      wrap(approvalItem, { onResolve });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /approve/i }));

      expect(onResolve).toHaveBeenCalledWith("tu-gate", "approve");
    });

    it("calls onResolve with reject when Reject is clicked", async () => {
      const onResolve = vi.fn();
      wrap(approvalItem, { onResolve });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /reject/i }));

      expect(onResolve).toHaveBeenCalledWith("tu-gate", "reject");
    });
  });

  describe("clarification_card", () => {
    const clarItem: TranscriptItem = {
      kind: "clarification_card",
      toolUseId: "tu-clar",
      toolName: "AskUserQuestion",
      input: {},
      question: "Which service first?",
      options: [
        { label: "nginx", description: "web server" },
        { label: "postgres", description: "database" },
      ],
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
      wrap({ ...clarItem, multiSelect: true }, { onAnswer });

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
  });

  describe("continue_card", () => {
    const continueItem = {
      kind: "continue_card" as const,
      toolUseId: "continue-uuid-1",
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

  describe("repo tool cards", () => {
    const DIFF_RESULT = {
      path: "src/app.ts",
      diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 42;",
    };

    it("renders Edit results as a colored diff card", () => {
      wrap({
        kind: "tool_card",
        toolUseId: "tu-1",
        toolName: "Edit",
        input: { path: "src/app.ts" },
        result: DIFF_RESULT,
      });

      expect(screen.getByTestId("diff-card")).toBeInTheDocument();
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("+const a = 42;")).toBeInTheDocument();
      expect(screen.getByText("-const a = 1;")).toBeInTheDocument();
      // File-header lines are folded into the card header, not the body.
      expect(screen.queryByText("--- a/src/app.ts")).not.toBeInTheDocument();
    });

    it("parses the persisted JSON-string form of a diff result too", () => {
      wrap({
        kind: "tool_card",
        toolUseId: "tu-2",
        toolName: "Write",
        input: { path: "src/app.ts" },
        result: JSON.stringify(DIFF_RESULT),
      });

      expect(screen.getByTestId("diff-card")).toBeInTheDocument();
      expect(screen.getByText("+const a = 42;")).toBeInTheDocument();
    });


    it("renders OpenPullRequest results as a PR card with the GitHub link", () => {
      wrap({
        kind: "tool_card",
        toolUseId: "tu-4",
        toolName: "OpenPullRequest",
        input: { title: "Fix the leak" },
        result: {
          action: "created",
          number: 42,
          url: "https://github.com/acme/api/pull/42",
          draft: true,
          message: "Created draft PR #42.",
          verification: { ran: true, command: "pnpm run test", passed: true },
        },
      });

      expect(screen.getByTestId("pr-card")).toBeInTheDocument();
      expect(screen.getByText("Pull request #42")).toBeInTheDocument();
      expect(screen.getByText("Draft")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /view on github/i }),
      ).toHaveAttribute("href", "https://github.com/acme/api/pull/42");
      expect(screen.getByText(/pnpm run test passed/)).toBeInTheDocument();
    });





  });
});
