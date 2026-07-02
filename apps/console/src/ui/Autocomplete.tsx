import "./TextInput.css";
import "./Select.css";

import {
  Autocomplete as MantineAutocomplete,
  type AutocompleteProps as MantineAutocompleteProps,
} from "@mantine/core";

type AutocompleteProps = {
  label?: MantineAutocompleteProps["label"];
  data?: MantineAutocompleteProps["data"];
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
};

export function Autocomplete({
  className,
  ...props
}: AutocompleteProps): React.JSX.Element {
  return (
    <MantineAutocomplete
      variant="unstyled"
      classNames={{
        root: "field",
        label: "field__label",
        input: className ? `input ${className}` : "input",
        dropdown: "select__dropdown",
        option: "select__option",
      }}
      {...props}
    />
  );
}
