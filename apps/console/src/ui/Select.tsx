import "./TextInput.css";
import "./Select.css";

import {
  Select as MantineSelect,
  type SelectProps as MantineSelectProps,
} from "@mantine/core";

type SelectProps = Omit<MantineSelectProps, "unstyled" | "classNames"> & {
  label?: string;
  data: string[] | { value: string; label: string; group?: string }[];
  value: string | null;
  onChange: (value: string | null) => void;
  w?: "xs" | "sm" | "md" | "lg";
};

export function Select({ w, ...props }: SelectProps): React.JSX.Element {
  return (
    <MantineSelect
      variant="unstyled"
      classNames={{
        root: `field${w ? ` field--${w}` : ""}`,
        label: "field__label",
        description: "field__description",
        input: "input select__input",
        error: "field__error",
        dropdown: "select__dropdown",
        option: "select__option",
        section: "select__section",
      }}
      {...props}
    />
  );
}
