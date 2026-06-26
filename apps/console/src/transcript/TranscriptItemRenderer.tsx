import { useState } from "react";
import {
  Button,
  Checkbox,
  Radio,
  Text,
  Textarea,
  UnstyledButton,
} from "@mantine/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  TranscriptItem,
  ThinkingItem,
  ApprovalCardItem,
  ClarificationCardItem,
  ContinueCardItem,
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
  const [otherChecked, setOtherChecked] = useState(false);
  const [otherText, setOtherText] = useState("");
  const resolved = item.approval === "answered";
  const disabled = item.approval === "pending";

  // The request_clarification tool description tells the LLM the UI already
  // offers a free-text Other answer, so it should never include one of its
  // own in options.
  const options = item.options ?? [];

  function toggleOption(label: string): void {
    if (item.multiSelect) {
      setSelected((prev) =>
        prev.includes(label)
          ? prev.filter((l) => l !== label)
          : [...prev, label],
      );
    } else {
      setOtherChecked(false);
      setSelected([label]);
    }
  }

  function toggleOther(): void {
    if (item.multiSelect) {
      setOtherChecked((prev) => !prev);
    } else {
      setSelected([]);
      setOtherChecked(true);
    }
  }

  function handleSubmit(): void {
    const otherTrimmed = otherText.trim();
    if (item.multiSelect) {
      const answers =
        otherChecked && otherTrimmed ? [...selected, otherTrimmed] : selected;
      if (answers.length === 0) return;
      onAnswer?.(answers);
    } else {
      if (otherChecked) {
        if (!otherTrimmed) return;
        onAnswer?.(otherTrimmed);
      } else if (selected.length > 0) {
        onAnswer?.(selected[0]);
      }
    }
  }

  const canSubmit = item.multiSelect
    ? selected.length > 0 || (otherChecked && otherText.trim().length > 0)
    : (otherChecked && otherText.trim().length > 0) || selected.length > 0;

  return (
    <>
      <div
        data-testid="clarification-card"
        style={{
          border: "1px solid var(--nw-status-awaiting)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
          padding: "var(--mantine-spacing-xs)",
          marginBottom: "var(--mantine-spacing-xs)",
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
              flexDirection: "column",
              gap: "var(--mantine-spacing-xs)",
            }}
          >
            {item.multiSelect ? (
              <>
                {options.map((opt) => (
                  <Checkbox
                    key={opt.label}
                    label={opt.label}
                    checked={selected.includes(opt.label)}
                    disabled={disabled}
                    onChange={() => toggleOption(opt.label)}
                  />
                ))}
                <Checkbox
                  label="Other"
                  checked={otherChecked}
                  disabled={disabled}
                  onChange={toggleOther}
                />
              </>
            ) : (
              <Radio.Group
                value={otherChecked ? "__other__" : (selected[0] ?? "")}
                onChange={(value) => {
                  if (value === "__other__") {
                    toggleOther();
                  } else {
                    toggleOption(value);
                  }
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--mantine-spacing-xs)",
                  }}
                >
                  {options.map((opt) => (
                    <Radio
                      key={opt.label}
                      value={opt.label}
                      label={opt.label}
                      disabled={disabled}
                    />
                  ))}
                  <Radio value="__other__" label="Other" disabled={disabled} />
                </div>
              </Radio.Group>
            )}
            {otherChecked && (
              <Textarea
                size="xs"
                placeholder="Type your answer…"
                value={otherText}
                onChange={(e) => setOtherText(e.currentTarget.value)}
                disabled={disabled}
                autosize
                minRows={1}
                maxRows={4}
              />
            )}
            <Button
              size="xs"
              disabled={disabled || !canSubmit}
              onClick={handleSubmit}
            >
              Submit
            </Button>
          </div>
        )}
      </div>
      {resolved && item.result !== undefined && (
        <ToolCardPanel
          toolName={item.toolName}
          input={item.input}
          result={item.result}
        />
      )}
    </>
  );
}

function ContinueCardPanel({
  item,
  onResolve,
}: {
  item: ContinueCardItem;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const resolved =
    item.approval === "continued" || item.approval === "rejected";
  const disabled = item.approval === "pending";

  return (
    <div
      data-testid="continue-card"
      style={{
        border: "1px solid var(--nw-status-awaiting)",
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--nw-surface)",
        padding: "var(--mantine-spacing-xs)",
      }}
    >
      <Text size="xs" mb="xs">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </Text>
      {resolved ? (
        <Text size="xs" data-testid="continue-resolution">
          {item.approval === "continued" ? "Resumed" : "Ended"}
          {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </Text>
      ) : (
        <div style={{ display: "flex", gap: "var(--mantine-spacing-xs)" }}>
          <Button
            size="xs"
            color="streaming"
            disabled={disabled}
            onClick={() => onResolve?.("approve")}
          >
            Resume
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onResolve?.("reject")}
          >
            End investigation
          </Button>
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
