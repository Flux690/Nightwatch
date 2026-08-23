import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";

/* How wide the box is is a fact about the value, not about the page: an
   address or a secret runs as long as its column, and a tenant or a region
   never will, so a box sized for one promises room the other cannot use. */
const MEASURE = {
  column: "w-full",
  beside: "w-control",
  short: "w-full max-w-control-sm",
} as const;

function Input({
  className,
  type,
  measure = "column",
  ...props
}: React.ComponentProps<"input"> & { measure?: keyof typeof MEASURE }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 min-w-0 rounded-md border-[0.5px] border-input bg-transparent px-3 py-1 text-base transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
        MEASURE[measure],
        className,
      )}
      {...props}
    />
  );
}

export { Input };
