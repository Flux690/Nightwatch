import { useState } from "react";
import { Button } from "../ui/Button.js";
import { Checkbox } from "../ui/Checkbox.js";
import { Radio, RadioGroup } from "../ui/Radio.js";
import { Text } from "../ui/Text.js";
import { Textarea } from "../ui/Textarea.js";
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
        className="interrupt-card"
        data-resolved={resolved || undefined}
      >
        <Text className="text-sm">{item.question}</Text>
        {resolved ? (
          <Text className="text-sm" data-testid="clarification-resolution">
            Answered{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </Text>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
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
              <RadioGroup
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
                    gap: 8,
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
              </RadioGroup>
            )}
            {otherChecked && (
              <Textarea
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
              size="sm"
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
