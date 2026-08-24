import type { RunnerRecord } from "@nightwarden/shared";
import { StatusText } from "@/shared/ui/status";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { timeAgo } from "@/shared/lib/time";
import { cn } from "@/shared/lib/utils";

// The user-assigned server name is the primary label everywhere; the
// self-reported OS hostname is the fallback when no name was given.
export function runnerDisplayName(runner: RunnerRecord): string {
  return runner.serverName ?? runner.hostname ?? runner.id;
}

const COLLAPSED_SERVICES = 6;

// A server owns a variable-length list of services, which is why this is a card
// and not a table row: a row has one line of height and clips the rest.
export function ServerCard({
  runner,
  actions,
}: {
  runner: RunnerRecord;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const online = runner.online;
  const keys = (runner.manifest?.services ?? []).map((entry) => entry.target);
  const shown = keys.slice(0, COLLAPSED_SERVICES);
  const rest = keys.slice(COLLAPSED_SERVICES);

  return (
    <Card
      data-testid="server-card"
      data-offline={!runner.online || undefined}
      className={cn("gap-2 px-4 py-4", !runner.online && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{runnerDisplayName(runner)}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {runner.hostname !== null && runner.hostname !== runner.serverName
              ? `host ${runner.hostname}`
              : null}
            {runner.hostname !== null && runner.hostname !== runner.serverName
              ? " · "
              : null}
            {runner.platform}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusText tone={online ? "ok" : "muted"}>
            {online ? "Online" : "Offline"}
          </StatusText>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {timeAgo(runner.lastSeen)}
          </span>
        </div>
      </div>

      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No services advertised yet.
        </p>
      ) : (
        <Collapsible className="flex flex-col gap-1">
          {shown.map((key) => (
            <span key={key} className="font-mono text-sm break-all">
              {key}
            </span>
          ))}
          {rest.length > 0 && (
            <>
              <CollapsibleContent className="flex flex-col gap-1">
                {rest.map((key) => (
                  <span key={key} className="font-mono text-sm break-all">
                    {key}
                  </span>
                ))}
              </CollapsibleContent>
              <CollapsibleTrigger
                render={<Button variant="link" className="self-start" />}
              >
                {rest.length} more
              </CollapsibleTrigger>
            </>
          )}
        </Collapsible>
      )}

      {actions !== undefined && (
        <div className="flex justify-end">{actions}</div>
      )}
    </Card>
  );
}
