import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* Rest and hover, and hover moves the background only: a label or an icon that
   changes colour under the pointer reads as a second, competing signal. */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    /* size is declared first so a variant can override it. Only link does: an
       inline text action is the one button that must carry no box. */
    variants: {
      size: {
        default: "h-8 gap-2 px-4",
        xs: "h-6 gap-1 px-2 text-sm [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-3 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 gap-2 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline:
          "border-border bg-background hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover aria-expanded:bg-secondary",
        ghost: "hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "bg-destructive-tint text-destructive hover:bg-destructive-wash",
        /* Underlined at rest, not on hover: a link must read as one without
           relying on hue. Cobalt is reserved for hover, per the colour rule. */
        link: "h-auto gap-1 p-0 text-ink-subtle underline decoration-border underline-offset-2 hover:text-primary-ink hover:decoration-primary-ink",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
