import { cn } from "@/lib/utils";

/* Shared shell for approval / clarification / continue interrupt cards.
   Left border is amber (warning) while pending, and fades to the neutral
   border once resolved. */
export function InterruptCard({
  resolved,
  className,
  ...props
}: React.ComponentProps<"div"> & { resolved?: boolean }): React.JSX.Element {
  return (
    <div
      data-resolved={resolved || undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border border-l-[3px] bg-card px-4 py-3.5",
        resolved ? "border-l-border" : "border-l-warning",
        className,
      )}
      {...props}
    />
  );
}
