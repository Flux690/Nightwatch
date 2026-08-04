import type { AgentConfig } from "@nightwarden/shared";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DurationField } from "./DurationField";
import { FIELD_HINT, FIELD_WIDTH, GROUP_HEADING, NO_SPINNERS } from "./layout";

// Both the closed trigger and the open list read from here, so the word an
// operator sees before opening is the same word they pick.
const NETWORK_LABEL: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist: "Allowlist (recommended)",
  open: "Open (unrestricted)",
  none: "None (no network)",
};

const NETWORK_HINT: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist:
    "All sandbox traffic is forced through an enforcing proxy that reaches only the hosts below. The agent installs dependencies itself.",
  none: "The sandbox gets no network at all: read and edit sessions only. Dependencies can never install, so tests will not run.",
  open: "The agent keeps full internet access for the whole session. A prompt-injected agent could exfiltrate repository content.",
};

interface SandboxSectionProps {
  form: AgentConfig;
  setField: <K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ) => void;
}

export function SandboxSection({
  form,
  setField,
}: SandboxSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h4 className={GROUP_HEADING}>Container</h4>
        <DurationField
          id="settings-sandbox-idle"
          label="Idle cleanup"
          unit="min"
          hint="A sandbox nobody has used for this long is torn down."
          valueMs={form.sandboxIdleTimeoutMs}
          onChangeMs={(ms) => setField("sandboxIdleTimeoutMs", ms)}
        />
        <Field>
          <FieldLabel htmlFor="settings-sandbox-cpus">CPU cores</FieldLabel>
          {/* Field stretches its own children to full width, so the box that
              holds the digits is the child and the width lives inside it. */}
          <div>
            <Input
              id="settings-sandbox-cpus"
              type="number"
              min={1}
              className={`${FIELD_WIDTH.number} ${NO_SPINNERS}`}
              value={form.sandboxCpus}
              onChange={(e) => {
                const next = Number(e.currentTarget.value);
                setField("sandboxCpus", Number.isFinite(next) ? next : 1);
              }}
            />
          </div>
        </Field>
        <Field>
          <FieldLabel htmlFor="settings-sandbox-memory">Memory (MB)</FieldLabel>
          <div>
            <Input
              id="settings-sandbox-memory"
              type="number"
              min={256}
              step={256}
              className={`${FIELD_WIDTH.number} ${NO_SPINNERS}`}
              value={form.sandboxMemoryMb}
              onChange={(e) => {
                const next = Number(e.currentTarget.value);
                setField("sandboxMemoryMb", Number.isFinite(next) ? next : 256);
              }}
            />
          </div>
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={form.sandboxRequireGvisor === true}
            onCheckedChange={(checked) =>
              setField("sandboxRequireGvisor", checked === true)
            }
          />
          <span>
            Require gVisor
            <span className={`block ${FIELD_HINT}`}>
              Refuse to start a sandbox unless the Docker host provides the
              gVisor (runsc) runtime. Off by default: gVisor is used
              automatically when present.
            </span>
          </span>
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className={GROUP_HEADING}>Network</h4>
        <Field className={FIELD_WIDTH.select}>
          <FieldLabel id="settings-sandbox-network-label">
            Agent network
          </FieldLabel>
          <Select
            items={NETWORK_LABEL}
            value={form.sandboxNetwork}
            onValueChange={(value) =>
              setField(
                "sandboxNetwork",
                value === "open"
                  ? "open"
                  : value === "none"
                    ? "none"
                    : "allowlist",
              )
            }
          >
            <SelectTrigger id="settings-sandbox-network">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(NETWORK_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <p className={FIELD_HINT}>{NETWORK_HINT[form.sandboxNetwork]}</p>
        {form.sandboxNetwork === "allowlist" && (
          <Field className={FIELD_WIDTH.text}>
            <FieldLabel htmlFor="settings-sandbox-allowlist">
              Allowed hosts (one per line)
            </FieldLabel>
            {/* Grows with its content up to a cap, then scrolls: the height
                follows the list rather than a drag handle. */}
            <Textarea
              id="settings-sandbox-allowlist"
              className="max-h-56 min-h-24 resize-none overflow-y-auto font-mono"
              rows={Math.min(
                12,
                Math.max(3, form.sandboxAllowlistHosts.length + 1),
              )}
              value={form.sandboxAllowlistHosts.join("\n")}
              onChange={(e) =>
                setField(
                  "sandboxAllowlistHosts",
                  e.currentTarget.value.split("\n"),
                )
              }
            />
          </Field>
        )}
      </section>
    </div>
  );
}
