import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ClarificationCardItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";
import { firstLines, IO_LABEL_CLASS, TOOL_CARD_CLASS } from "./cardChrome.js";

export function ClarificationCardPanel({
  item,
  submitting = false,
  onAnswer,
}: {
  item: ClarificationCardItem;
  submitting?: boolean;
  onAnswer?: (answer: string | string[]) => void;
}): React.JSX.Element {
  const state = item.state;
  const resolved = state.phase === "resolved";
  const answer = state.phase === "resolved" ? state.result : undefined;
  const answeredBy = state.phase === "resolved" ? state.by : undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const [otherChecked, setOtherChecked] = useState(false);
  const [otherText, setOtherText] = useState("");

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

  // Once answered, the interactive card collapses into one compact Q/A card:
  // the question in, the human's answer out, nothing else.
  if (resolved) {
    const answerText =
      typeof answer === "string"
        ? answer
        : answer !== undefined
          ? JSON.stringify(answer)
          : null;
    return (
      <div data-testid="clarification-card" data-resolved="true">
        <p className="mb-2 font-mono text-base font-medium">
          AskUserQuestion
          {answeredBy ? (
            <span
              className="ml-2 font-normal text-muted-foreground"
              data-testid="clarification-resolution"
            >
              answered by {answeredBy}
            </span>
          ) : null}
        </p>
        <Card size="sm" className={TOOL_CARD_CLASS}>
          <CardContent className="px-4">
            <p className={IO_LABEL_CLASS}>IN</p>
            <p className="m-0 overflow-hidden text-base whitespace-pre-wrap">
              {firstLines(item.question ?? "")}
            </p>
          </CardContent>
          <CardContent className="px-4">
            <p className={IO_LABEL_CLASS}>OUT</p>
            <p className="m-0 overflow-hidden text-base whitespace-pre-wrap">
              {answerText === null ? "Answered" : firstLines(answerText)}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <InterruptCard data-testid="clarification-card" resolved={resolved}>
      <p className="text-sm">{item.question}</p>
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
