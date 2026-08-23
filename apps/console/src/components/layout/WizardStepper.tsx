import { Progress } from "@/components/ui/progress";
import { SECTION_HEADING } from "@/components/layout/Page";
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
      <div className={cn("mb-1", SECTION_HEADING)}>
        Step {step + 1} of {total}
      </div>
      <div className="mb-4 text-lg font-semibold tracking-tight text-foreground">
        {title}
      </div>
      {/* Discrete segments rather than one filling bar, because the steps are
          countable. The root still owns every aria attribute. */}
      <Progress
        className="flex gap-2"
        min={1}
        max={total}
        value={step + 1}
        getAriaValueText={() => `Step ${step + 1} of ${total}: ${title}`}
      >
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            data-done={i <= step || undefined}
            className={cn(
              "h-[3px] flex-1 rounded-full transition-colors",
              i <= step ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </Progress>
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
