import { useState } from "react";
import { Button, Checkbox, Radio, Text, Textarea } from "@mantine/core";
import type { ClarificationCardItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";

export function ClarificationCardPanel({
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
