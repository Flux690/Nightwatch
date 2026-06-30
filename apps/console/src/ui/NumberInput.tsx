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
      unstyled
      classNames={{
        root: "field",
        label: "field__label",
        input: className ? `input ${className}` : "input",
        error: "field__error",
        controls: "field__controls",
        control: "field__control",
      }}
      {...props}
    />
  );
}
