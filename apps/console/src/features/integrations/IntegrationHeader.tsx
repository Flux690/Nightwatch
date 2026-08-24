import type { IntegrationIdentity } from "@/features/integrations/catalog";
import { cn } from "@/shared/lib/utils";

/* The square is white because vendor logos are drawn for light ground; anything
   monochrome inherits dark ink from it. */
export function IntegrationLogo({
  logo,
  className,
}: {
  logo: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md bg-white text-background",
        className,
      )}
    >
      <img src={logo} alt="" className="size-5" />
    </span>
  );
}

// Who this page is about, before what it asks for.
export function IntegrationHeader({
  identity,
}: {
  identity: IntegrationIdentity;
}): React.JSX.Element {
  return (
    <div data-testid="integration-header" className="flex items-start gap-3">
      <IntegrationLogo logo={identity.logo} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base leading-tight font-medium">
          {identity.label}
        </span>
        <span className="text-sm text-muted-foreground">
          {identity.description}
        </span>
      </span>
    </div>
  );
}
