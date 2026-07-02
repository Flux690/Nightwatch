import "./Select.css";

import {
  Select as MantineSelect,
  type SelectProps as MantineSelectProps,
} from "@mantine/core";

type SelectProps = Omit<MantineSelectProps, "unstyled" | "classNames"> & {
  label?: string;
  data: string[] | { value: string; label: string }[];
  value: string | null;
  onChange: (value: string | null) => void;
};

export function Select({ ...props }: SelectProps): React.JSX.Element {
  return (
    <MantineSelect
      variant="unstyled"
      classNames={{
        input: "input select__input",
        dropdown: "select__dropdown",
        option: "select__option",
      }}
      {...props}
    />
  );
}
