import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CheckboxOption } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupOption } from "@/components/ui/radio-group";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { asRecord, stringAt } from "@/lib/toolResult";
import type { ToolCallItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";

/* The raised form of a question, drawn only while it is unanswered. Pinned
   unlike an approval, because a question stops the whole run rather than one
   tool: there is nothing else for the reader to be doing. */

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

/* The number is the affordance and the fill is the answer, so the row carries no
   tick and no dot; selection rides the primitive's own data-checked. */
const ROW =
  "flex w-full items-baseline gap-3 rounded-md px-3 py-2 hover:bg-state-hover data-checked:bg-control data-checked:hover:bg-control-hover";

function OptionBody({
  index,
  label,
  description,
  describedBy,
}: {
  index: number;
  label: string;
  description?: string;
  describedBy?: string;
}): React.JSX.Element {
  return (
    <>
      <span className="w-3 shrink-0 font-mono text-sm text-ink-subtle tabular-nums">
        {index + 1}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm">{label}</span>
        {description && (
          <span id={describedBy} className="text-sm font-light">
            {description}
          </span>
        )}
      </span>
    </>
  );
}

function OptionRow({
  index,
  label,
  description,
  selected,
  multiSelect,
  disabled,
  onPick,
}: {
  index: number;
  label: string;
  description?: string;
  selected: boolean;
  multiSelect: boolean;
  disabled: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const describedBy = description ? `opt-${index}-desc` : undefined;
  const body = (
    <OptionBody
      index={index}
      label={label}
      description={description}
      describedBy={describedBy}
    />
  );
  if (multiSelect) {
    return (
      <CheckboxOption
        className={ROW}
        aria-label={label}
        aria-describedby={describedBy}
        checked={selected}
        disabled={disabled}
        onCheckedChange={onPick}
      >
        {body}
      </CheckboxOption>
    );
  }
  return (
    <RadioGroupOption
      className={ROW}
      value={String(index)}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      {body}
    </RadioGroupOption>
  );
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
  // Held by position, not by label: nothing stops a model offering the same
  // label twice, and by label that would select both and collide on the key.
  const [selected, setSelected] = useState<number[]>([]);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherRef = useRef<HTMLInputElement>(null);

  // The free-text row is the last one and is always offered: the tool promises
  // the model it exists, which is why it may not spend an option on one.
  const otherIndex = options.length;

  function pickOption(index: number): void {
    if (multiSelect) {
      setSelected((prev) =>
        prev.includes(index)
          ? prev.filter((i) => i !== index)
          : [...prev, index],
      );
      return;
    }
    setOtherOpen(false);
    setSelected([index]);
  }

  function pickOther(): void {
    if (!multiSelect) setSelected([]);
    setOtherOpen(true);
    // The row becomes the field, so opening it and putting the caret in it are
    // one act - anything else asks for a second click on what was just chosen.
    requestAnimationFrame(() => otherRef.current?.focus());
  }

  // Opening the free-text row is not answering it, so an empty one submits
  // nothing however deliberately it was opened.
  const otherTrimmed = otherText.trim();
  const canSubmit = selected.length > 0 || otherTrimmed.length > 0;

  function handleSubmit(): void {
    if (!canSubmit || submitting) return;
    const picked = selected.map((i) => options[i]!.label);
    if (multiSelect) {
      onAnswer?.(otherTrimmed ? [...picked, otherTrimmed] : picked);
      return;
    }
    onAnswer?.(otherTrimmed || picked[0]!);
  }

  /* A printed number a keyboard cannot press is a promise not kept. Bound while
     this card is what the run waits on, and never over a field: the message box
     sits directly beneath it and must keep every key it is given. */
  useEffect(() => {
    if (submitting) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.key === "Enter") {
        event.preventDefault();
        handleSubmit();
        return;
      }
      const picked = Number(event.key);
      if (!Number.isInteger(picked) || picked < 1 || picked > otherIndex + 1)
        return;
      event.preventDefault();
      if (picked === otherIndex + 1) pickOther();
      else pickOption(picked - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <InterruptCard data-testid="clarification-card">
      <div className="flex flex-col gap-1">
        <p className="text-sm">{question}</p>
        {/* Words rather than a glyph, so every row stays identical in both
            modes. Without it, one click is the only way to learn a second
            answer was ever available. */}
        {multiSelect && (
          <p className="text-sm text-ink-subtle">Pick any that apply</p>
        )}
      </div>

      {(() => {
        const rows = (
          <>
            {options.map((opt, i) => (
              <OptionRow
                key={`${i}-${opt.label}`}
                index={i}
                label={opt.label}
                description={opt.description}
                selected={selected.includes(i)}
                multiSelect={multiSelect}
                disabled={submitting}
                onPick={() => pickOption(i)}
              />
            ))}

            {/* The row becomes the field rather than revealing one beneath it:
                nothing below moves, which matters for a card pinned above the
                message box, and the answer stays where its number is. */}
            {otherOpen ? (
              <InputGroup className="h-auto w-full border-transparent bg-control py-1">
                <span className="w-3 shrink-0 pl-3 font-mono text-sm text-ink-subtle tabular-nums">
                  {otherIndex + 1}
                </span>
                <InputGroupInput
                  ref={otherRef}
                  aria-label="Your own answer"
                  placeholder="Type your answer…"
                  value={otherText}
                  disabled={submitting}
                  onChange={(e) => setOtherText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    handleSubmit();
                  }}
                />
              </InputGroup>
            ) : (
              <OptionRow
                index={otherIndex}
                label="Other"
                selected={false}
                multiSelect={multiSelect}
                disabled={submitting}
                onPick={pickOther}
              />
            )}
          </>
        );
        return multiSelect ? (
          <div
            role="group"
            aria-label={question}
            className="flex flex-col gap-1"
          >
            {rows}
          </div>
        ) : (
          <RadioGroup
            aria-label={question}
            className="flex flex-col gap-1"
            value={selected[0] !== undefined ? String(selected[0]) : null}
            onValueChange={(value) => {
              const picked = Number(value);
              if (picked === otherIndex) pickOther();
              else pickOption(picked);
            }}
          >
            {rows}
          </RadioGroup>
        );
      })()}

      <div className="flex justify-end">
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
