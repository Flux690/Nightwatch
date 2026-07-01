import { useState } from "react";
import { Text } from "../ui/Text.js";
import { UnstyledButton } from "../ui/UnstyledButton.js";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem, ThinkingItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";
import { ApprovalCardPanel } from "./ApprovalCardPanel.js";
import { ClarificationCardPanel } from "./ClarificationCardPanel.js";
import { ContinueCardPanel } from "./ContinueCardPanel.js";

function UserTurn({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-testid="user-turn" className="user-turn">
      <div className="user-turn__label">You</div>
      <Text className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </Text>
    </div>
  );
}

function AgentMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: "0.875rem",
        lineHeight: 1.6,
      }}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

function ThinkingBlock({ item }: { item: ThinkingItem }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div data-testid="thinking-block" data-streaming={item.streaming}>
      <UnstyledButton
        onClick={() => setExpanded((prev) => !prev)}
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        <Text
          className={`text-xs text-ink-muted font-semibold${item.streaming ? " thinking-pulse" : ""}`}
        >
          Thinking
        </Text>
        <Text className="text-xs text-ink-muted" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </Text>
      </UnstyledButton>
      <div style={{ display: expanded ? "block" : "none" }}>
        <Text
          className="text-xs text-ink-muted"
          style={{ whiteSpace: "pre-wrap", paddingLeft: 16, paddingTop: 4 }}
        >
          {item.text}
        </Text>
      </div>
    </div>
  );
}

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
      return <UserTurn text={item.text} />;
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
