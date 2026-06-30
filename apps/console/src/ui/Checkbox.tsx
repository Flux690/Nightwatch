import "./Checkbox.css";

import { Checkbox as MantineCheckbox } from "@mantine/core";

type CheckboxProps = {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  className?: string;
};

export function Checkbox({
  className,
  ...props
}: CheckboxProps): React.JSX.Element {
  return (
    <MantineCheckbox
      unstyled
      classNames={{
        root: className ? `checkbox ${className}` : "checkbox",
        input: "checkbox__input",
        icon: "checkbox__icon",
        inner: "checkbox__inner",
        body: "checkbox__body",
        label: "checkbox__label",
      }}
      {...props}
    />
  );
}
