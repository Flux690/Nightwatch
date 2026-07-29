import type { AgentConfig } from "@nightwarden/shared";

import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DurationField } from "./DurationField";
import { FIELD_HINT, FIELD_WIDTH, GROUP_HEADING, NO_SPINNERS } from "./layout";

interface LimitsSectionProps {
  form: AgentConfig;
  setField: <K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ) => void;
}

// Grouped by what each number applies to, outermost first. The five values used
// to sit in one grid at the same visual level while operating at three
// different scopes, which is what made them unreadable.
export function LimitsSection({
  form,
  setField,
}: LimitsSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h4 className={GROUP_HEADING}>Investigation</h4>
        <DurationField
          id="settings-check-in"
          label="Check in after"
          unit="min"
          hint="The agent finishes the step it is on, then asks whether to continue. Time spent waiting for an approval does not count."
          valueMs={form.checkInAfterMs}
          onChangeMs={(ms) => setField("checkInAfterMs", ms)}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h4 className={GROUP_HEADING}>Model request</h4>
        <DurationField
          id="settings-request-timeout"
          label="Timeout"
          unit="sec"
          valueMs={form.requestTimeoutMs}
          onChangeMs={(ms) => setField("requestTimeoutMs", ms)}
        />
        <div className="flex flex-col gap-1">
          <Field>
            <FieldLabel htmlFor="settings-max-retries">Retries</FieldLabel>
            {/* Field stretches its own children to full width, so the box that
                holds the digits is the child and the width lives inside it. */}
            <div>
              <Input
                id="settings-max-retries"
                type="number"
                min={0}
                className={`${FIELD_WIDTH.number} ${NO_SPINNERS}`}
                value={form.maxRetries}
                onChange={(e) => {
                  const next = Number(e.currentTarget.value);
                  setField("maxRetries", Number.isFinite(next) ? next : 0);
                }}
              />
            </div>
          </Field>
          <p className={FIELD_HINT}>
            How many times a failed request is retried, with a growing wait
            between attempts, before the run fails.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className={GROUP_HEADING}>Tool call</h4>
        <DurationField
          id="settings-tool-ceiling"
          label="Maximum"
          unit="min"
          hint="No single tool call may run longer than this. Individual tools set their own lower limits, from 30 seconds for a metrics query up to 10 minutes for installing dependencies."
          valueMs={form.toolCallCeilingMs}
          onChangeMs={(ms) => setField("toolCallCeilingMs", ms)}
        />
      </section>
    </div>
  );
}
