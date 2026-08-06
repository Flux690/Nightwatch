import { useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { SettingsRow } from "./SettingsRow";
import { CONTROL, NO_SPINNERS } from "./layout";

const UNIT_MS = { sec: 1_000, min: 60_000 } as const;

interface NumberRowProps {
  id: string;
  title: string;
  description?: string;
  unit?: string;
  min?: number;
  value: number;
  onCommit: (value: number) => void;
}

// The draft holds what is being typed and nothing leaves until the field is
// left, so a half-typed 4 is never saved where 4096 was meant.
export function NumberRow({
  id,
  title,
  description,
  unit,
  min = 0,
  value,
  onCommit,
}: NumberRowProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <SettingsRow controlId={id} title={title} description={description}>
      {/* The unit rides inside the box, so the bordered edge is what lines up
          with every other control rather than sitting short of it. */}
      <InputGroup className={CONTROL.number}>
        <InputGroupInput
          id={id}
          type="number"
          min={min}
          className={NO_SPINNERS}
          value={draft ?? String(value)}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => {
            if (draft === null) return;
            const next = Number(draft);
            onCommit(Number.isFinite(next) ? next : min);
            setDraft(null);
          }}
        />
        {unit !== undefined && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{unit}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </SettingsRow>
  );
}

// Stored in milliseconds, shown in the unit a person says it in.
export function DurationRow({
  unit,
  valueMs,
  onCommitMs,
  ...rest
}: Omit<NumberRowProps, "value" | "onCommit" | "unit"> & {
  unit: keyof typeof UNIT_MS;
  valueMs: number;
  onCommitMs: (ms: number) => void;
}): React.JSX.Element {
  const factor = UNIT_MS[unit];
  return (
    <NumberRow
      {...rest}
      unit={unit}
      value={Math.round(valueMs / factor)}
      onCommit={(next) => onCommitMs(next * factor)}
    />
  );
}
