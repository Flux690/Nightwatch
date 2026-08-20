import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* The raised state of a tool call, not a kind of its own: what a run parks on
   while it waits for a person. Depth rather than an outline - one rung above
   the message bubbles and the chat input - so it is found by sitting higher
   than the column instead of by a border competing with every other edge. */
export function InterruptCard({
  className,
  ...props
}: React.ComponentProps<typeof Card>): React.JSX.Element {
  return (
    <Card className={cn("gap-3 px-4 py-4 ring-0", className)} {...props} />
  );
}
