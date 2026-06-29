import "./Radio.css";

import React from "react";

type RadioProps = Omit<React.ComponentPropsWithoutRef<"input">, "type"> & {
  label: string;
};

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  function Radio({ label, className, ...rest }, ref) {
    return (
      <label className={className ? `radio ${className}` : "radio"}>
        <input ref={ref} type="radio" {...rest} />
        <span>{label}</span>
      </label>
    );
  },
);
