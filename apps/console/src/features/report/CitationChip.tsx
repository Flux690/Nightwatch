import { ArrowUpRight } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { revealToolCall } from "@/features/session/transcript/revealToolCall";

// A bordered pill so it reads as a control at rest without spending hue, and
// an arrow because it leaves this page for the transcript.
export function CitationChip({
  toolUseId,
  toolName,
}: {
  toolUseId: string;
  toolName: string;
}): React.JSX.Element {
  return (
    /* Not a native title: that never appears on keyboard focus, and where a
       control goes is exactly what a keyboard user needs before pressing it. */
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 rounded-full font-mono text-ink-subtle hover:border-primary-ink hover:bg-transparent hover:text-primary-ink"
            onClick={() => revealToolCall(toolUseId)}
          />
        }
      >
        <ArrowUpRight aria-hidden />
        {toolName}
      </TooltipTrigger>
      <TooltipContent>Show {toolName} in the transcript</TooltipContent>
    </Tooltip>
  );
}
