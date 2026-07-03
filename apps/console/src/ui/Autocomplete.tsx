import "./TextInput.css";
import "./Select.css";

import {
  Autocomplete as MantineAutocomplete,
  type AutocompleteProps as MantineAutocompleteProps,
} from "@mantine/core";
import { ChevronDown } from "lucide-react";

type AutocompleteProps = {
  label?: MantineAutocompleteProps["label"];
  description?: MantineAutocompleteProps["description"];
  data?: MantineAutocompleteProps["data"];
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  w?: "xs" | "sm" | "md" | "lg";
};

export function Autocomplete({
  className,
  w,
  ...props
}: AutocompleteProps): React.JSX.Element {
  return (
    <MantineAutocomplete
      variant="unstyled"
      rightSection={<ChevronDown size={16} strokeWidth={1.75} aria-hidden />}
      rightSectionPointerEvents="none"
      classNames={{
        root: `field${w ? ` field--${w}` : ""}`,
        label: "field__label",
        description: "field__description",
        input: className ? `input ${className}` : "input",
        error: "field__error",
        dropdown: "select__dropdown",
        option: "select__option",
      }}
      {...props}
    />
  );
}
