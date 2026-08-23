import * as React from "react";

import { cn } from "@/lib/utils";

/* Quoted content, not a control: it takes the surface rung and no edge. A
   raised fill with a border is neither of the two forms styles.css allows. */
function CodeBlock({ className, ...props }: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="code-block"
      className={cn(
        "block overflow-auto rounded-md bg-raised p-3 font-mono text-sm leading-normal break-all whitespace-pre-wrap text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { CodeBlock };
