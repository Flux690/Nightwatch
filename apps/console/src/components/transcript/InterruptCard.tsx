import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* Swaps Card's ring for a border so the left accent can change color with
   state: amber while pending, neutral once resolved. */
export function InterruptCard({
  resolved,
  className,
  ...props
}: React.ComponentProps<typeof Card> & {
  resolved?: boolean;
}): React.JSX.Element {
  return (
    <Card
      data-resolved={resolved || undefined}
      className={cn(
        "gap-2 rounded-none ring-0 border border-border border-l-[3px] px-4 py-3.5",
        resolved ? "border-l-border" : "border-l-warning",
        className,
      )}
      {...props}
    />
  );
}
