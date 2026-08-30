import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "@/shared/lib/utils";
import { CheckIcon } from "lucide-react";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-sm border border-input transition-colors group-has-disabled/field:border-border after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:border-border disabled:data-checked:bg-disabled aria-invalid:border-destructive aria-invalid:aria-checked:border-primary data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/* The checkbox counterpart of RadioGroupOption: children are the affordance,
   so a row that already marks itself does not also carry a tick. */
function CheckboxOption({
  className,
  children,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox-option"
      className={cn(
        "w-full text-left transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:text-disabled-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, CheckboxOption };
