import { Card } from "@/components/ui/card";
import { FieldLabel } from "@/components/ui/field";
import { SectionHeading } from "@/components/layout/Page";
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
        <FieldLabel htmlFor={controlId}>{title}</FieldLabel>
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
      {title !== undefined && <SectionHeading>{title}</SectionHeading>}
      <Card className="gap-0 py-0">{children}</Card>
    </section>
  );
}
