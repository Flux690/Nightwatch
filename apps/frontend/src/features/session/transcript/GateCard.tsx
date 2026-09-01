import { Card } from "@/shared/ui/card";
import { cn } from "@/shared/lib/utils";

// Depth rather than an outline, one rung above the bubbles, so it is found by
// sitting higher than the column rather than by another border.
export function GateCard({
  className,
  ...props
}: React.ComponentProps<typeof Card>): React.JSX.Element {
  return (
    <Card className={cn("gap-3 px-4 py-4 ring-0", className)} {...props} />
  );
}
