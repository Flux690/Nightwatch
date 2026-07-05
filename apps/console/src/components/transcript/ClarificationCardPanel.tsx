import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ClarificationCardItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";
import { InterruptCard } from "./InterruptCard.js";

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
      <InterruptCard data-testid="clarification-card" resolved={resolved}>
        <p className="text-sm">{item.question}</p>
        {resolved ? (
          <p className="text-sm" data-testid="clarification-resolution">
            Answered{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {item.multiSelect ? (
              <>
                {options.map((opt) => (
                  <label
                    key={opt.label}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(opt.label)}
                      disabled={disabled}
                      onCheckedChange={() => toggleOption(opt.label)}
                    />
                    {opt.label}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={otherChecked}
                    disabled={disabled}
                    onCheckedChange={toggleOther}
                  />
                  Other
                </label>
              </>
            ) : (
              <RadioGroup
                value={otherChecked ? "__other__" : (selected[0] ?? "")}
                onValueChange={(value) => {
                  if (value === "__other__") {
                    toggleOther();
                  } else {
                    toggleOption(value as string);
                  }
                }}
              >
                {options.map((opt) => (
                  <label
                    key={opt.label}
                    className="flex items-center gap-2 text-sm"
                  >
                    <RadioGroupItem value={opt.label} disabled={disabled} />
                    {opt.label}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="__other__" disabled={disabled} />
                  Other
                </label>
              </RadioGroup>
            )}
            {otherChecked && (
              <Textarea
                placeholder="Type your answer…"
                value={otherText}
                onChange={(e) => setOtherText(e.currentTarget.value)}
                disabled={disabled}
                className="max-h-32 min-h-9"
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
      </InterruptCard>
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
