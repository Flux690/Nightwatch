import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MantineProvider } from "@mantine/core";

import { TranscriptItemRenderer } from "../transcript/TranscriptItemRenderer.js";
import type { TranscriptItem } from "../transcript/types.js";
import { theme, cssVariablesResolver } from "../theme.js";

function wrap(
  item: TranscriptItem,
  opts?: {
    onResolve?: (toolUseId: string, action: "approve" | "reject") => void;
    onAnswer?: (toolUseId: string, answer: string | string[]) => void;
  },
): void {
  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
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
    </MantineProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TranscriptItemRenderer", () => {
  describe("user_turn — right-aligned bubble", () => {
    it("renders the user text inside a bubble", () => {
      wrap({ kind: "user_turn", id: "u1", text: "Hello agent" });

      expect(screen.getByText("Hello agent")).toBeInTheDocument();
    });

    it("bubble wrapper is right-aligned", () => {
      wrap({ kind: "user_turn", id: "u1", text: "Hello agent" });

      const bubble = screen.getByTestId("user-bubble");
      const style = window.getComputedStyle(bubble);
      expect(
        style.justifyContent === "flex-end" || style.marginLeft === "auto",
      ).toBe(true);
    });
  });

  describe("agent_text — full-width markdown", () => {
    it("renders a code span as a <code> element", () => {
      wrap({ kind: "agent_text", id: "a1", text: "`ping -c 3 8.8.8.8`" });

      expect(document.querySelector("code")).toBeInTheDocument();
      expect(screen.getByText(/ping -c 3 8\.8\.8\.8/)).toBeInTheDocument();
    });

    it("renders a list as <li> elements", () => {
      wrap({ kind: "agent_text", id: "a2", text: "- item1\n- item2" });

      const items = document.querySelectorAll("li");
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it("does not render raw HTML from agent text as DOM elements", () => {
      wrap({ kind: "agent_text", id: "a3", text: "<script>alert(1)</script>" });

      expect(document.querySelector("script")).not.toBeInTheDocument();
    });
  });

  describe("thinking", () => {
    it("shows a pulsing Thinking label while streaming", () => {
      wrap({
        kind: "thinking",
        id: "th-1",
        text: "Checking the logs",
        streaming: true,
        collapsed: false,
      });

      const label = screen.getByText("Thinking");
      expect(label).toBeInTheDocument();
      expect(label.closest('[data-testid="thinking-block"]')).toHaveAttribute(
        "data-streaming",
        "true",
      );
    });

    it("auto-expands and shows the streamed text while streaming", () => {
      wrap({
        kind: "thinking",
        id: "th-1",
        text: "Checking the logs",
        streaming: true,
        collapsed: false,
      });

      expect(screen.getByText("Checking the logs")).toBeVisible();
    });

    it("renders collapsed (text hidden) when collapsed and not streaming", () => {
      wrap({
        kind: "thinking",
        id: "th-1",
        text: "Checking the logs",
        streaming: false,
        collapsed: true,
      });

      expect(screen.getByText("Thinking")).toBeInTheDocument();
      expect(screen.queryByText("Checking the logs")).not.toBeVisible();
    });

    it("expands again when the header is clicked", async () => {
      wrap({
        kind: "thinking",
        id: "th-1",
        text: "Checking the logs",
        streaming: false,
        collapsed: true,
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /thinking/i }));

      expect(screen.getByText("Checking the logs")).toBeVisible();
    });

    it("does not pulse once collapsed and no longer streaming", () => {
      wrap({
        kind: "thinking",
        id: "th-1",
        text: "Checking the logs",
        streaming: false,
        collapsed: true,
      });

      expect(screen.getByTestId("thinking-block")).toHaveAttribute(
        "data-streaming",
        "false",
      );
    });
  });

  describe("tool_card", () => {
    const toolItem: TranscriptItem = {
      kind: "tool_card",
      toolUseId: "tu-1",
      toolName: "check_service_status",
      input: { service: "nginx" },
      result: null,
    };

    it("shows toolName, IN and OUT labels", () => {
      wrap(toolItem);

      expect(screen.getByText("check_service_status")).toBeInTheDocument();
      expect(screen.getByText("IN")).toBeInTheDocument();
      expect(screen.getByText("OUT")).toBeInTheDocument();
    });

    it("shows loading placeholder while result is null", () => {
      wrap(toolItem);

      expect(screen.getByTestId("tool-card-out-loading")).toBeInTheDocument();
    });

    it("shows the serialized result when result is set", () => {
      wrap({ ...toolItem, result: { status: "stopped" } });

      expect(
        screen.queryByTestId("tool-card-out-loading"),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/stopped/)).toBeInTheDocument();
    });
  });

  describe("approval_card", () => {
    const approvalItem: TranscriptItem = {
      kind: "approval_card",
      toolUseId: "tu-gate",
      toolName: "restart_container",
      input: { containerName: "web-01" },
      result: null,
      risk: "high",
    };

    it("renders approval card with toolName, risk and action buttons", () => {
      wrap(approvalItem);

      const card = screen.getByTestId("approval-card");
      expect(within(card).getByText("restart_container")).toBeInTheDocument();
      expect(within(card).getByText(/high/i)).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /approve/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /reject/i }),
      ).toBeInTheDocument();
    });

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

    it("shows resolution text and no buttons when approved", () => {
      wrap({ ...approvalItem, approval: "approved", resolvedBy: "operator" });

      const card = screen.getByTestId("approval-card");
      expect(
        within(card).getByText(/approved by operator/i),
      ).toBeInTheDocument();
      expect(
        within(card).queryByRole("button", { name: /approve/i }),
      ).not.toBeInTheDocument();
    });

    it("renders tool card below the approval card when approved", () => {
      wrap({
        ...approvalItem,
        approval: "approved",
        result: { restarted: true },
      });

      expect(screen.getByText(/restarted/)).toBeInTheDocument();
      expect(
        screen.queryByTestId("tool-card-out-loading"),
      ).not.toBeInTheDocument();
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

    it("renders the question and option buttons", () => {
      wrap(clarItem);

      const card = screen.getByTestId("clarification-card");
      expect(
        within(card).getByText("Which service first?"),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /nginx/i }),
      ).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /postgres/i }),
      ).toBeInTheDocument();
    });

    it("calls onAnswer when an option button is clicked", async () => {
      const onAnswer = vi.fn();
      wrap(clarItem, { onAnswer });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /nginx/i }));

      expect(onAnswer).toHaveBeenCalledWith("tu-clar", "nginx");
    });

    it("shows Answered label when approval is answered", () => {
      wrap({ ...clarItem, approval: "answered", resolvedBy: "operator" });

      const card = screen.getByTestId("clarification-card");
      expect(
        within(card).getByText(/answered by operator/i),
      ).toBeInTheDocument();
      expect(
        within(card).queryByRole("button", { name: /nginx/i }),
      ).not.toBeInTheDocument();
    });

    it("multiSelect: accumulates selection and posts all on Submit", async () => {
      const onAnswer = vi.fn();
      wrap({ ...clarItem, multiSelect: true }, { onAnswer });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /nginx/i }));
      await user.click(screen.getByRole("button", { name: /postgres/i }));
      await user.click(screen.getByRole("button", { name: /submit/i }));

      expect(onAnswer).toHaveBeenCalledWith("tu-clar", ["nginx", "postgres"]);
    });
  });

  describe("transcript column layout", () => {
    it("transcript-column has centered max-width layout", () => {
      wrap({ kind: "user_turn", id: "u1", text: "Hi" });

      const col = screen.getByTestId("transcript-column");
      const style = window.getComputedStyle(col);
      expect(parseInt(style.maxWidth)).toBeGreaterThan(0);
      expect(
        style.marginLeft === "auto" ||
          style.margin === "0 auto" ||
          style.margin.includes("auto"),
      ).toBe(true);
    });
  });
});
