import * as React from "react";
import { cva } from "class-variance-authority";
import { CircleAlert, TriangleAlert } from "lucide-react";

import { ICON_UI } from "@/lib/iconProps";
import { cn } from "@/lib/utils";

/* No neutral rung. An alert that carries no tone is a paragraph, and one drawn
   as a box anyway is a box the eye stops at for nothing. */
type AlertVariant = "destructive" | "warning";

const alertVariants = cva(
  "group/alert relative grid w-full grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-left text-sm *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
  {
    variants: {
      variant: {
        destructive:
          "bg-destructive-tint text-destructive *:data-[slot=alert-description]:text-destructive",
        warning:
          "bg-warning-tint text-warning *:data-[slot=alert-description]:text-warning",
      },
    },
  },
);

/* The icon is the component's, not the call site's: it says the same thing the
   variant says, so leaving it to be passed in is one more way for a box to end
   up looking unlike the box beside it. */
const ICON: Record<AlertVariant, typeof TriangleAlert> = {
  destructive: CircleAlert,
  warning: TriangleAlert,
};

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & { variant: AlertVariant }) {
  const Icon = ICON[variant];
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon {...ICON_UI} />
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 font-medium [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 text-sm text-balance md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
