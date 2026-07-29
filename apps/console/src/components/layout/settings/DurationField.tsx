import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FIELD_HINT, FIELD_WIDTH, NO_SPINNERS } from "./layout";

const UNIT_MS = { sec: 1_000, min: 60_000 } as const;

interface DurationFieldProps {
  id: string;
  label: string;
  hint?: string;
  unit: keyof typeof UNIT_MS;
  valueMs: number;
  onChangeMs: (ms: number) => void;
}

// Stored in milliseconds, shown in the unit a person says it in. The unit sits
// directly beside the digits rather than at the far edge of a wide box.
export function DurationField({
  id,
  label,
  hint,
  unit,
  valueMs,
  onChangeMs,
}: DurationFieldProps): React.JSX.Element {
  const factor = UNIT_MS[unit];
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          className={`${FIELD_WIDTH.number} ${NO_SPINNERS}`}
          value={Math.round(valueMs / factor)}
          onChange={(e) => {
            const next = Number(e.currentTarget.value);
            onChangeMs(Number.isFinite(next) ? next * factor : 0);
          }}
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {hint && <p className={FIELD_HINT}>{hint}</p>}
    </Field>
  );
}
