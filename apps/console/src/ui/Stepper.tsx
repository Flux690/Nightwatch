import "./Stepper.css";

import {
  Stepper as MantineStepper,
  type StepperProps as MantineStepperProps,
  type StepperStepProps as MantineStepperStepProps,
} from "@mantine/core";

type StepperProps = {
  active: MantineStepperProps["active"];
  onStepClick?: MantineStepperProps["onStepClick"];
  allowNextStepsSelect?: MantineStepperProps["allowNextStepsSelect"];
  className?: string;
  children: React.ReactNode;
};

export function Stepper({
  className,
  ...props
}: StepperProps): React.JSX.Element {
  return (
    <MantineStepper
      classNames={{
        root: className ? `stepper ${className}` : "stepper",
        steps: "stepper__steps",
        step: "stepper__step",
        stepIcon: "stepper__icon",
        stepLabel: "stepper__label",
        stepBody: "stepper__body",
        separator: "stepper__separator",
        content: "stepper__content",
      }}
      {...props}
    />
  );
}

type StepperStepProps = {
  label?: MantineStepperStepProps["label"];
  className?: string;
  children?: React.ReactNode;
};

export function StepperStep(props: StepperStepProps): React.JSX.Element {
  return <MantineStepper.Step {...props} />;
}
