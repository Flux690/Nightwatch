import "./TextInput.css";

import {
  NumberInput as MantineNumberInput,
  type NumberInputProps as MantineNumberInputProps,
} from "@mantine/core";

type NumberInputProps = {
  label?: MantineNumberInputProps["label"];
  value?: number | string;
  onChange?: MantineNumberInputProps["onChange"];
  className?: string;
};

export function NumberInput({
  className,
  ...props
}: NumberInputProps): React.JSX.Element {
  return (
    <MantineNumberInput
      variant="unstyled"
      classNames={{
        root: "field",
        label: "field__label",
        input: className
          ? `input input--tnum ${className}`
          : "input input--tnum",
        error: "field__error",
        control: "field__control",
      }}
      {...props}
    />
  );
}
