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
};

export function TextInput({
  className,
  ...props
}: TextInputProps): React.JSX.Element {
  return (
    <MantineTextInput
      variant="unstyled"
      classNames={{
        root: "field",
        label: "field__label",
        description: "field__description",
        input: className ? `input ${className}` : "input",
        error: "field__error",
      }}
      {...props}
    />
  );
}
