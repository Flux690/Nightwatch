import "./Radio.css";

import {
  Radio as MantineRadio,
  type RadioGroupProps as MantineRadioGroupProps,
} from "@mantine/core";

type RadioProps = {
  value?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
};

export function Radio({ className, ...props }: RadioProps): React.JSX.Element {
  return (
    <MantineRadio
      classNames={{
        root: className ? `radio ${className}` : "radio",
        radio: "radio__input",
        icon: "radio__icon",
        inner: "radio__inner",
        body: "radio__body",
        label: "radio__label",
      }}
      {...props}
    />
  );
}

type RadioGroupProps = {
  label?: MantineRadioGroupProps["label"];
  description?: MantineRadioGroupProps["description"];
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
};

export function RadioGroup({
  className,
  ...props
}: RadioGroupProps): React.JSX.Element {
  return (
    <MantineRadio.Group
      classNames={{
        root: className ? `radio-group ${className}` : "radio-group",
        label: "field__label",
        description: "field__description",
      }}
      {...props}
    />
  );
}
