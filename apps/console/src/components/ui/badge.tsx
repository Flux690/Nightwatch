import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary",
        destructive:
          "bg-destructive-tint text-destructive [a]:hover:bg-destructive-tint",
        success:
          "bg-success-tint text-success [a]:hover:bg-success-tint",
        warning:
          "bg-warning-tint text-warning [a]:hover:bg-warning-tint",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const dotClass: Record<NonNullable<VariantProps<typeof badgeVariants>["variant"]>, string> = {
  default: "bg-primary-foreground",
  secondary: "bg-secondary-foreground",
  destructive: "bg-destructive",
  success: "bg-success",
  warning: "bg-warning",
  outline: "bg-foreground",
  ghost: "bg-foreground",
  link: "bg-primary",
}

function Badge({
  className,
  variant = "default",
  dot = false,
  render,
  children,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      {
        ...props,
        children: dot ? (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                dotClass[variant ?? "default"]
              )}
            />
            {children}
          </>
        ) : (
          children
        ),
      }
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
