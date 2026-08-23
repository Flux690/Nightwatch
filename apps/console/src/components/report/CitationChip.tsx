import { ArrowUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
