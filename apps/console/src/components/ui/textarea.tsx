import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border-[0.5px] border-input bg-transparent hover:border-input-hover px-3 py-2 text-base transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:border-border disabled:text-disabled-foreground aria-invalid:border-destructive md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
