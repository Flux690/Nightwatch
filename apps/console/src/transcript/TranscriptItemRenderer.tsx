import { useState } from "react";
import { Text, UnstyledButton } from "@mantine/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem, ThinkingItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";
import { ApprovalCardPanel } from "./ApprovalCardPanel.js";
import { ClarificationCardPanel } from "./ClarificationCardPanel.js";
import { ContinueCardPanel } from "./ContinueCardPanel.js";

function UserBubble({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      data-testid="user-bubble"
      style={{
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          maxWidth: "75%",
          background: "var(--nw-surface-raised)",
          border: "1px solid var(--nw-border)",
          borderRadius: "var(--mantine-radius-md)",
          padding: "var(--mantine-spacing-xs) var(--mantine-spacing-sm)",
        }}
      >
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {text}
        </Text>
      </div>
    </div>
  );
}

function AgentMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: "var(--mantine-font-size-sm)",
        lineHeight: 1.6,
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function ThinkingBlock({ item }: { item: ThinkingItem }): React.JSX.Element {
  // Always starts collapsed, live or reloaded alike - the operator opens it
  // explicitly; nothing auto-expands or forces it shut.
  const [expanded, setExpanded] = useState(false);

  return (
    <div data-testid="thinking-block" data-streaming={item.streaming}>
      <UnstyledButton
        onClick={() => setExpanded((prev) => !prev)}
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        <Text
          size="xs"
          c="dimmed"
          fw={600}
          className={item.streaming ? "nw-thinking-pulse" : undefined}
        >
          Thinking
        </Text>
        <Text size="xs" c="dimmed" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </Text>
      </UnstyledButton>
      <div style={{ display: expanded ? "block" : "none" }}>
        <Text
          size="xs"
          c="dimmed"
          style={{ whiteSpace: "pre-wrap", paddingLeft: 16, paddingTop: 4 }}
        >
          {item.text}
        </Text>
      </div>
    </div>
  );
}

// Dispatches a transcript item to its card/block; each card type lives in its own
// file, this only routes by kind and threads the resolve/answer callbacks.
export function TranscriptItemRenderer({
  item,
  onResolve,
  onAnswer,
}: {
  item: TranscriptItem;
  onResolve?: (toolUseId: string, action: "approve" | "reject") => void;
  onAnswer?: (toolUseId: string, answer: string | string[]) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "user_turn":
      return <UserBubble text={item.text} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool_card":
      return (
        <ToolCardPanel
          toolName={item.toolName}
          input={item.input}
          result={item.result}
        />
      );
    case "approval_card":
      return (
        <ApprovalCardPanel
          item={item}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolUseId, action)
              : undefined
          }
        />
      );
    case "clarification_card":
      return (
        <ClarificationCardPanel
          item={item}
          onAnswer={
            onAnswer ? (answer) => onAnswer(item.toolUseId, answer) : undefined
          }
        />
      );
    case "continue_card":
      return (
        <ContinueCardPanel
          item={item}
          onResolve={
            onResolve
              ? (action) => onResolve(item.toolUseId, action)
              : undefined
          }
        />
      );
  }
}
