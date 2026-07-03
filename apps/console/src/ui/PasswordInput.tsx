import "./TextInput.css";
import "./PasswordInput.css";

import {
  PasswordInput as MantinePasswordInput,
  type PasswordInputProps as MantinePasswordInputProps,
} from "@mantine/core";

type PasswordInputProps = {
  label?: MantinePasswordInputProps["label"];
  description?: MantinePasswordInputProps["description"];
  required?: boolean;
  placeholder?: string;
  value?: string;
  error?: MantinePasswordInputProps["error"];
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  className?: string;
  w?: "xs" | "sm" | "md" | "lg";
};

export function PasswordInput({
  className,
  w,
  ...props
}: PasswordInputProps): React.JSX.Element {
  return (
    <MantinePasswordInput
      variant="unstyled"
      classNames={{
        root: `field${w ? ` field--${w}` : ""}`,
        label: "field__label",
        description: "field__description",
        error: "field__error",
        input: className
          ? `input input--password ${className}`
          : "input input--password",
        innerInput: "password-input__inner",
        visibilityToggle: "password-input__toggle",
      }}
      {...props}
    />
  );
}
