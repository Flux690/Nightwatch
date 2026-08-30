"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/shared/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  );
}

/* A radio whose children are the affordance. For rows that mark themselves some
   other way - a number, a fill - and would read as two controls with a dot. */
function RadioGroupOption({
  className,
  children,
  ...props
}: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-option"
      className={cn(
        "w-full text-left transition-colors duration-(--duration-fast) disabled:pointer-events-none disabled:text-disabled-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupOption };
