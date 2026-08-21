import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* The raised state of a tool call, not a kind of its own. Depth rather than an
   outline, one rung above the bubbles and the message box, so it is found by
   sitting higher than the column rather than by another border. */
export function InterruptCard({
  className,
  ...props
}: React.ComponentProps<typeof Card>): React.JSX.Element {
  return (
    <Card className={cn("gap-3 px-4 py-4 ring-0", className)} {...props} />
  );
}
