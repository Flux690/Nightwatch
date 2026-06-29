import "./Checkbox.css";

import React from "react";

type CheckboxProps = Omit<React.ComponentPropsWithoutRef<"input">, "type"> & {
  label: string;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, className, ...rest }, ref) {
    return (
      <label className={className ? `checkbox ${className}` : "checkbox"}>
        <input ref={ref} type="checkbox" {...rest} />
        <span>{label}</span>
      </label>
    );
  },
);
