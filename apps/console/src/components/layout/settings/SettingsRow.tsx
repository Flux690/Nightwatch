import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SECTION_HEADING } from "@/components/layout/Page";
import { cn } from "@/lib/utils";

interface SettingsRowProps {
  controlId: string;
  title: string;
  description?: string;
  // For a control too tall to sit beside its label, the allowlist being the
  // only one: it drops below and takes the full width.
  stacked?: boolean;
  // Drops the rule below, for a row the next one belongs to.
  joined?: boolean;
  children: React.ReactNode;
}

export function SettingsRow({
  controlId,
  title,
  description,
  stacked = false,
  joined = false,
  children,
}: SettingsRowProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex p-4",
        !joined && "not-last:border-b not-last:border-border",
        stacked ? "flex-col gap-2" : "items-center justify-between gap-6",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {/* htmlFor labels an input; the id is what a Select's trigger adopts,
            since <label for> cannot label a button. */}
        <Label htmlFor={controlId} id={`${controlId}-label`}>
          {title}
        </Label>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className={cn(stacked ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      {title !== undefined && <h3 className={SECTION_HEADING}>{title}</h3>}
      <Card className="gap-0 py-0">{children}</Card>
    </section>
  );
}
