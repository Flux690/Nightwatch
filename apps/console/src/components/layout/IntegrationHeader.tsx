import type { IntegrationIdentity } from "@/pages/integrationCatalog";

/* Who this page is about, before what it asks for. The square is white because
   vendor logos are drawn for light ground; anything monochrome inherits dark
   ink from it. */
export function IntegrationHeader({
  identity,
}: {
  identity: IntegrationIdentity;
}): React.JSX.Element {
  return (
    <div data-testid="integration-header" className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white text-background">
        <img src={identity.logo} alt="" className="size-5" />
      </span>
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
