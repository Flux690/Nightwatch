import { cn } from "@/lib/utils";

/* Page shell for data screens (Fleet, Audit log, Unresolved alerts,
   Add server). Single max-width (--container-page), centered, column flow. */
export function Page({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-full w-full max-w-page flex-col p-6 max-md:p-3 max-lg:px-4",
        className,
      )}
      {...props}
    />
  );
}

/* Header row: title left, actions right. */
export function PageHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.JSX.Element {
  return (
    <header
      className={cn(
        "mb-4 flex shrink-0 items-center justify-between",
        className,
      )}
      {...props}
    />
  );
}

export function PageTitle({
  className,
  ...props
}: React.ComponentProps<"h1">): React.JSX.Element {
  return (
    <h1
      className={cn(
        "m-0 text-2xl font-semibold tracking-[-0.3px] text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/* Shared class for a back link (used with router <Link> to keep navigation). */
export const backLinkClass =
  "mb-2 inline-flex items-center gap-1 self-start rounded-sm text-sm font-medium text-muted-foreground no-underline hover:text-foreground hover:underline";

/* Bordered card wrapper for a data table. */
export function PageTableWrap({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-xl border border-border bg-card",
        className,
      )}
      {...props}
    />
  );
}

/* Two-region left-aligned empty state used across the data screens. */
export function EmptyState({
  className,
  children,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn("flex flex-1 items-center justify-center", className)}
      {...props}
    >
      <div className="flex max-w-[380px] flex-col items-start text-left">
        {children}
      </div>
    </div>
  );
}
