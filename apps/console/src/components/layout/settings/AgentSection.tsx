import type { AgentConfig } from "@nightwarden/shared";

import { SettingsGroup } from "./SettingsRow";
import { DurationRow, NumberRow } from "./NumberRow";

interface AgentSectionProps {
  config: AgentConfig;
  save: (patch: Partial<AgentConfig>) => void;
}

// Grouped by what each number applies to, outermost first: three scopes, which
// is what made one flat list unreadable. Sandbox limits describe a container.
export function AgentSection({
  config,
  save,
}: AgentSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="Investigation">
        <NumberRow
          id="settings-max-concurrent"
          title="Maximum concurrent investigations"
          description="Alerts beyond this wait their turn. One waiting on your approval still counts."
          value={config.maxConcurrentInvestigations}
          onCommit={(n) => save({ maxConcurrentInvestigations: n })}
        />
        <DurationRow
          id="settings-check-in"
          title="Check in after"
          description="The agent finishes its step, then asks whether to continue."
          unit="min"
          valueMs={config.checkInAfterMs}
          onCommitMs={(ms) => save({ checkInAfterMs: ms })}
        />
      </SettingsGroup>

      <SettingsGroup title="Model request">
        <DurationRow
          id="settings-request-timeout"
          title="Timeout"
          description="How long one request to the model may take."
          unit="sec"
          valueMs={config.requestTimeoutMs}
          onCommitMs={(ms) => save({ requestTimeoutMs: ms })}
        />
        <NumberRow
          id="settings-max-retries"
          title="Retries"
          description="How many times a failed request is retried before the run fails."
          value={config.maxRetries}
          onCommit={(n) => save({ maxRetries: n })}
        />
      </SettingsGroup>

      <SettingsGroup title="Tool call">
        <DurationRow
          id="settings-tool-ceiling"
          title="Maximum"
          description="No single tool call may run longer than this."
          unit="min"
          valueMs={config.toolCallCeilingMs}
          onCommitMs={(ms) => save({ toolCallCeilingMs: ms })}
        />
      </SettingsGroup>
    </div>
  );
}
