import { useState } from "react";
import { Button, Text } from "@mantine/core";
import Markdown from "react-markdown";
import type {
  TranscriptItem,
  ApprovalCardItem,
  ClarificationCardItem,
  ToolCardItem,
} from "./types.js";

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
      <Markdown>{text}</Markdown>
    </div>
  );
}

function ToolCardPanel({
  toolName,
  input,
  result,
}: Pick<ToolCardItem, "toolName" | "input" | "result">): React.JSX.Element {
  return (
    <div>
      <Text size="xs" ff="monospace" fw={600} mb={4}>
        {toolName}
      </Text>
      <div
        style={{
          border: "1px solid var(--nw-border)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            IN
          </Text>
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--nw-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
        <div style={{ borderTop: "1px solid var(--nw-border)" }} />
        <div style={{ padding: "var(--mantine-spacing-xs)" }}>
          <Text size="xs" c="dimmed" ff="monospace" mb={4}>
            OUT
          </Text>
          {result === null ? (
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              data-testid="tool-card-out-loading"
            >
              …
            </Text>
          ) : (
            <pre
              style={{
                margin: 0,
                fontFamily: "var(--nw-mono)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalCardPanel({
  item,
  onResolve,
}: {
  item: ApprovalCardItem;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const resolved = item.approval === "approved" || item.approval === "rejected";

  return (
    <>
      <div
        data-testid="approval-card"
        style={{
          border: "1px solid var(--nw-status-awaiting)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
          padding: "var(--mantine-spacing-xs)",
          marginBottom: "var(--mantine-spacing-xs)",
        }}
      >
        <Text size="xs" ff="monospace" fw={600}>
          {item.toolName}
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          Risk: {item.risk ?? "unknown"}
        </Text>
        {resolved ? (
          <Text size="xs" data-testid="approval-resolution">
            {item.approval === "approved" ? "Approved" : "Rejected"}
            {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </Text>
        ) : (
          <div style={{ display: "flex", gap: "var(--mantine-spacing-xs)" }}>
            <Button
              size="xs"
              color="streaming"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("approve")}
            >
              Approve
            </Button>
            <Button
              size="xs"
              color="escalated"
              variant="outline"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("reject")}
            >
              Reject
            </Button>
          </div>
        )}
      </div>
      {resolved && (
        <ToolCardPanel
          toolName={item.toolName}
          input={item.input}
          result={item.result}
        />
      )}
    </>
  );
}

function ClarificationCardPanel({
  item,
  onAnswer,
}: {
  item: ClarificationCardItem;
  onAnswer?: (answer: string | string[]) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const resolved = item.approval === "answered";

  function handleOption(label: string): void {
    if (resolved || item.approval === "pending") return;
    if (item.multiSelect) {
      setSelected((prev) =>
        prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label],
      );
    } else {
      onAnswer?.(label);
    }
  }

  return (
    <div
      data-testid="clarification-card"
      style={{
        border: "1px solid var(--nw-status-awaiting)",
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--nw-surface)",
        padding: "var(--mantine-spacing-xs)",
      }}
    >
      <Text size="xs" mb="xs">
        {item.question}
      </Text>
      {resolved ? (
        <Text size="xs" data-testid="clarification-resolution">
          Answered{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </Text>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--mantine-spacing-xs)",
          }}
        >
          {item.options?.map((opt) => (
            <Button
              key={opt.label}
              size="xs"
              variant={selected.includes(opt.label) ? "filled" : "outline"}
              disabled={item.approval === "pending"}
              onClick={() => handleOption(opt.label)}
            >
              {opt.label}
            </Button>
          ))}
          {item.multiSelect && selected.length > 0 && (
            <Button
              size="xs"
              disabled={item.approval === "pending"}
              onClick={() => onAnswer?.(selected)}
            >
              Submit
            </Button>
          )}
        </div>
      )}
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
      return <UserBubble text={item.text} />;
    case "agent_text":
      return <AgentMarkdown text={item.text} />;
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
  }
}
