import "./TextInput.css";

import {
  PasswordInput as MantinePasswordInput,
  type PasswordInputProps as MantinePasswordInputProps,
} from "@mantine/core";

type PasswordInputProps = {
  label?: MantinePasswordInputProps["label"];
  required?: boolean;
  value?: string;
  error?: MantinePasswordInputProps["error"];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  className?: string;
};

export function PasswordInput({
  className,
  ...props
}: PasswordInputProps): React.JSX.Element {
  return (
    <MantinePasswordInput
      unstyled
      classNames={{
        root: "field",
        label: "field__label",
        input: className ? `input ${className}` : "input",
        innerInput: "input",
        error: "field__error",
        visibilityToggle: "icon-btn",
        wrapper: "field__wrapper",
      }}
      {...props}
    />
  );
}
