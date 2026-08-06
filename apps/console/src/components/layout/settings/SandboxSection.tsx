import type { AgentConfig } from "@nightwarden/shared";

import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup, SettingsRow } from "./SettingsRow";
import { DurationRow, NumberRow } from "./NumberRow";
import { CONTROL } from "./layout";

// Both the closed trigger and the open list read from here, so the word an
// operator sees before opening is the same word they pick.
const NETWORK_LABEL: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist: "Allowlist (recommended)",
  open: "Open (unrestricted)",
  none: "None (no network)",
};

const NETWORK_HINT: Record<AgentConfig["sandboxNetwork"], string> = {
  allowlist: "Reaches only the hosts listed below, through a proxy.",
  none: "No network at all, so dependencies can never install.",
  open: "Full internet access; a prompt-injected agent could exfiltrate code.",
};

interface SandboxSectionProps {
  config: AgentConfig;
  save: (patch: Partial<AgentConfig>) => void;
}

export function SandboxSection({
  config,
  save,
}: SandboxSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Container">
        <DurationRow
          id="settings-sandbox-idle"
          title="Idle cleanup"
          description="A sandbox nobody has used for this long is torn down."
          unit="min"
          valueMs={config.sandboxIdleTimeoutMs}
          onCommitMs={(ms) => save({ sandboxIdleTimeoutMs: ms })}
        />
        <NumberRow
          id="settings-sandbox-cpus"
          title="CPU cores"
          description="Cores each sandbox may use."
          min={1}
          value={config.sandboxCpus}
          onCommit={(n) => save({ sandboxCpus: n })}
        />
        <NumberRow
          id="settings-sandbox-memory"
          title="Memory"
          description="Megabytes each sandbox may use."
          unit="MB"
          min={256}
          value={config.sandboxMemoryMb}
          onCommit={(n) => save({ sandboxMemoryMb: n })}
        />
        <SettingsRow
          controlId="settings-sandbox-gvisor"
          title="Require gVisor"
          description="Whether a sandbox may start without kernel-level isolation."
        >
          <Switch
            id="settings-sandbox-gvisor"
            checked={config.sandboxRequireGvisor === true}
            onCheckedChange={(checked) =>
              save({ sandboxRequireGvisor: checked })
            }
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Network">
        <SettingsRow
          controlId="settings-sandbox-network"
          title="Sandbox network"
          description={`What the sandbox may reach. ${NETWORK_HINT[config.sandboxNetwork]}`}
          // The hosts below belong to this choice, so no line divides them.
          joined={config.sandboxNetwork === "allowlist"}
        >
          <Select
            items={NETWORK_LABEL}
            value={config.sandboxNetwork}
            onValueChange={(value) =>
              save({
                sandboxNetwork:
                  value === "open"
                    ? "open"
                    : value === "none"
                      ? "none"
                      : "allowlist",
              })
            }
          >
            <SelectTrigger
              id="settings-sandbox-network"
              className={CONTROL.select}
            >
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
        </SettingsRow>
        {config.sandboxNetwork === "allowlist" && (
          <SettingsRow
            controlId="settings-sandbox-allowlist"
            title="Allowed hosts"
            description="The hosts that proxy will pass through, one per line."
            stacked
          >
            <Textarea
              id="settings-sandbox-allowlist"
              className="max-h-56 min-h-24 resize-none overflow-y-auto font-mono"
              rows={Math.min(
                12,
                Math.max(3, config.sandboxAllowlistHosts.length + 1),
              )}
              defaultValue={config.sandboxAllowlistHosts.join("\n")}
              onBlur={(e) =>
                save({
                  sandboxAllowlistHosts: e.currentTarget.value
                    .split("\n")
                    .map((h) => h.trim())
                    .filter((h) => h.length > 0),
                })
              }
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </div>
  );
}
