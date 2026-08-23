import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { cn } from "@/lib/utils";

/* The root owns the semantics - role, valuemin, valuemax, valuenow, valuetext -
   so a caller that draws its own shape still announces correctly. */
function Progress({ className, ...props }: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("w-full", className)}
      {...props}
    />
  );
}

export { Progress };
