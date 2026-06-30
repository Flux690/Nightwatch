import "./TextInput.css";
import "./Textarea.css";

import {
  Textarea as MantineTextarea,
  type TextareaProps as MantineTextareaProps,
} from "@mantine/core";

type TextareaProps = {
  label?: MantineTextareaProps["label"];
  error?: MantineTextareaProps["error"];
  placeholder?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  disabled?: boolean;
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
  style?: React.CSSProperties;
  className?: string;
};

export function Textarea({
  className,
  ...props
}: TextareaProps): React.JSX.Element {
  return (
    <MantineTextarea
      unstyled
      classNames={{
        root: "field",
        label: "field__label",
        input: className ? `input textarea ${className}` : "input textarea",
        error: "field__error",
      }}
      {...props}
    />
  );
}
