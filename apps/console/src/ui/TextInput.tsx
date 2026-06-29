import "./TextInput.css";

import React from "react";

type TextInputProps = Omit<React.ComponentPropsWithoutRef<"input">, "id"> & {
  label?: string;
  error?: string;
  id?: string;
};

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    { label, error, id: externalId, className, ...rest },
    ref,
  ) {
    const generatedId = React.useId();
    const inputId = externalId ?? generatedId;
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className="field">
        {label && <label htmlFor={inputId}>{label}</label>}
        <input
          ref={ref}
          id={inputId}
          className={className ? `input ${className}` : "input"}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={errorId}
          {...rest}
        />
        {error && (
          <span id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  },
);
