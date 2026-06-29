import "./Button.css";

import React from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

type ButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  variant?: ButtonVariant;
  loading?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", loading, className, disabled, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={className ? `btn ${className}` : "btn"}
        data-variant={variant}
        aria-busy={loading ? "true" : undefined}
        disabled={loading || disabled}
        {...rest}
      />
    );
  },
);
