import "./TextInput.css";

import {
  TextInput as MantineTextInput,
  type TextInputProps as MantineTextInputProps,
} from "@mantine/core";

type TextInputProps = {
  label?: MantineTextInputProps["label"];
  description?: MantineTextInputProps["description"];
  error?: MantineTextInputProps["error"];
  type?: string;
  required?: boolean;
  placeholder?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  className?: string;
  w?: "xs" | "sm" | "md" | "lg";
};

export function TextInput({
  className,
  w,
  ...props
}: TextInputProps): React.JSX.Element {
  return (
    <MantineTextInput
      variant="unstyled"
      classNames={{
        root: `field${w ? ` field--${w}` : ""}`,
        label: "field__label",
        description: "field__description",
        input: className ? `input ${className}` : "input",
        error: "field__error",
      }}
      {...props}
    />
  );
}
