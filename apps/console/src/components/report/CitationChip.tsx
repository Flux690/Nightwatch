import { ArrowUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { revealToolCall } from "@/components/transcript/revealToolCall";

/* The one shape a citation takes, wherever the report names a call. A bordered
   pill so it reads as a control at rest without spending hue, and the arrow
   because it leaves the page you are on for the transcript. */
export function CitationChip({
  toolUseId,
  toolName,
}: {
  toolUseId: string;
  toolName: string;
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="xs"
      // A title, not an aria-label: the tool name is the accessible name, and
      // this says where pressing it goes.
      title={`Show ${toolName} in the transcript`}
      className="shrink-0 rounded-full font-mono text-ink-subtle hover:border-primary-ink hover:bg-transparent hover:text-primary-ink"
      onClick={() => revealToolCall(toolUseId)}
    >
      <ArrowUpRight aria-hidden />
      {toolName}
    </Button>
  );
}
