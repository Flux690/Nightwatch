import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { asRecord, stringAt } from "@/lib/toolResult";
import type { ToolCallItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";

/* The raised form of a question, which exists only while it is unanswered. An
   answered one is an ordinary row whose result is what the person said, so
   nothing here has a second life to draw.

   Unlike an approval this is pinned, because a question stops the whole run
   rather than one tool: there is nothing else for the reader to be doing. */

export interface QuestionOption {
  label: string;
  description: string;
}

// Read from the call's own arguments rather than from fields copied beside
// them: a copy is a second source, and this is the only reader.
export function questionOf(input: Record<string, unknown>): {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
} {
  const raw = input["options"];
  const options = (Array.isArray(raw) ? raw : []).flatMap(
    (entry): QuestionOption[] => {
      const record = asRecord(entry);
      const label = record === null ? null : stringAt(record, "label");
      if (record === null || label === null) return [];
      return [{ label, description: stringAt(record, "description") ?? "" }];
    },
  );
  return {
    question: stringAt(input, "question") ?? "",
    options,
    multiSelect: input["multiSelect"] === true,
  };
}

export function ClarificationCardPanel({
  item,
  submitting = false,
  onAnswer,
}: {
  item: ToolCallItem;
  submitting?: boolean;
  onAnswer?: (answer: string | string[]) => void;
}): React.JSX.Element {
  const { question, options, multiSelect } = questionOf(item.input);
  const [selected, setSelected] = useState<string[]>([]);
  const [otherChecked, setOtherChecked] = useState(false);
  const [otherText, setOtherText] = useState("");

  function toggleOption(label: string): void {
    if (multiSelect) {
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
    if (multiSelect) {
      setOtherChecked((prev) => !prev);
    } else {
      setSelected([]);
      setOtherChecked(true);
    }
  }

  function handleSubmit(): void {
    const otherTrimmed = otherText.trim();
    if (multiSelect) {
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

  const canSubmit = multiSelect
    ? selected.length > 0 || (otherChecked && otherText.trim().length > 0)
    : (otherChecked && otherText.trim().length > 0) || selected.length > 0;

  return (
    <InterruptCard data-testid="clarification-card">
      <p className="text-sm">{question}</p>
      <div className="flex flex-col gap-2">
        {multiSelect ? (
          <>
            {options.map((opt) => (
              <label
                key={opt.label}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={selected.includes(opt.label)}
                  disabled={submitting}
                  onCheckedChange={() => toggleOption(opt.label)}
                />
                {opt.label}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={otherChecked}
                disabled={submitting}
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
                <RadioGroupItem value={opt.label} disabled={submitting} />
                {opt.label}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="__other__" disabled={submitting} />
              Other
            </label>
          </RadioGroup>
        )}
        {otherChecked && (
          <Textarea
            placeholder="Type your answer…"
            value={otherText}
            onChange={(e) => setOtherText(e.currentTarget.value)}
            disabled={submitting}
            className="max-h-32 min-h-9"
          />
        )}
        <Button
          size="sm"
          disabled={submitting || !canSubmit}
          onClick={handleSubmit}
        >
          Submit
        </Button>
      </div>
    </InterruptCard>
  );
}
