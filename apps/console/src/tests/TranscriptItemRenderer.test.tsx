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
      toolName: "restart_service",
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
      toolName: "request_clarification",
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
});
