import { cn } from "@/lib/utils";

/* Step progress header for the add-server wizard: segments left of (and
   including) the active step read as done. */
export function WizardStepper({
  step,
  total,
  title,
}: {
  step: number;
  total: number;
  title: string;
}): React.JSX.Element {
  return (
    <div className="mb-8">
      <div className="mb-1 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
        Step {step + 1} of {total}
      </div>
      <div className="mb-4 text-lg font-semibold tracking-[-0.2px] text-foreground">
        {title}
      </div>
      <div
        className="flex gap-2"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={step + 1}
        aria-valuetext={`Step ${step + 1} of ${total}: ${title}`}
      >
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            data-done={i <= step || undefined}
            className={cn(
              "h-[3px] flex-1 rounded-full transition-colors duration-base ease-out",
              i <= step ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/* Footer action row for a wizard step: back on the left, next on the right. */
export function WizardActions({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn(
        "mt-8 flex justify-between border-t border-border pt-4",
        className,
      )}
      {...props}
    />
  );
}
