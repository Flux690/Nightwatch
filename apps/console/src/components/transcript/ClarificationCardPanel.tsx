import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { asRecord, stringAt } from "@/lib/toolResult";
import { cn } from "@/lib/utils";
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

/* One row per answer: its number, its label, and the sentence saying what
   picking it would mean. Two lines of real content give the row its own height,
   so the chosen fill has something to fill rather than invented padding.

   No tick and no dot. The number is the affordance and the fill is the answer,
   while the role and aria-checked keep saying "option 2 of 5, selected" to
   anyone who cannot see either. The label alone is the accessible name, so the
   description reads as description rather than being run onto the end of it. */
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
  return (
    <button
      type="button"
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full items-baseline gap-3 rounded-md px-3 py-2 text-left transition-colors duration-(--duration-fast)",
        selected ? "bg-control hover:bg-control-hover" : "hover:bg-state-hover",
      )}
    >
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
    </button>
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
     this card is what the run waits on, and never over a field: the composer
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

      <div
        role={multiSelect ? "group" : "radiogroup"}
        aria-label={question}
        className="flex flex-col gap-1"
      >
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
            composer, and the answer stays where its number is. */}
        {otherOpen ? (
          <div className="flex w-full items-baseline gap-3 rounded-md bg-control px-3 py-2">
            <span className="w-3 shrink-0 font-mono text-sm text-ink-subtle tabular-nums">
              {otherIndex + 1}
            </span>
            {/* Bare, not the Input primitive, whose height and border fight a
                box this row owns. The slot is how styles.css drops the focus edge. */}
            <input
              ref={otherRef}
              type="text"
              data-slot="input-group-control"
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
              className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground"
            />
          </div>
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
      </div>

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
