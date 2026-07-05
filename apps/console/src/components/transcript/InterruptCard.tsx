import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* Shared shell for approval / clarification / continue interrupt cards.
   Left border is amber (warning) while pending, and fades to the neutral
   border once resolved. Built on Card but swaps the ring for a border so
   the per-side left accent can change color with state. */
export function InterruptCard({
  resolved,
  className,
  ...props
}: React.ComponentProps<typeof Card> & { resolved?: boolean }): React.JSX.Element {
  return (
    <Card
      data-resolved={resolved || undefined}
      className={cn(
        "gap-2 ring-0 border border-border border-l-[3px] px-4 py-3.5",
        resolved ? "border-l-border" : "border-l-warning",
        className,
      )}
      {...props}
    />
  );
}
