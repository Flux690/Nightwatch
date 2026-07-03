import "./TextInput.css";

import {
  NumberInput as MantineNumberInput,
  type NumberInputProps as MantineNumberInputProps,
} from "@mantine/core";

type NumberInputProps = {
  label?: MantineNumberInputProps["label"];
  description?: MantineNumberInputProps["description"];
  value?: number | string;
  onChange?: MantineNumberInputProps["onChange"];
  step?: number;
  min?: number;
  hideControls?: boolean;
  className?: string;
  w?: "xs" | "sm" | "md" | "lg";
};

export function NumberInput({
  className,
  w,
  ...props
}: NumberInputProps): React.JSX.Element {
  return (
    <MantineNumberInput
      variant="unstyled"
      classNames={{
        root: `field${w ? ` field--${w}` : ""}`,
        label: "field__label",
        description: "field__description",
        input: className
          ? `input input--tnum input--number ${className}`
          : "input input--tnum input--number",
        error: "field__error",
        control: "field__control",
      }}
      {...props}
    />
  );
}
