import "./TextInput.css";
import "./Textarea.css";

import React from "react";

type TextareaProps = Omit<React.ComponentPropsWithoutRef<"textarea">, "id"> & {
  label?: string;
  error?: string;
  id?: string;
  autoGrow?: boolean;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { label, error, id: externalId, autoGrow, className, style, ...rest },
    ref,
  ) {
    const generatedId = React.useId();
    const inputId = externalId ?? generatedId;
    const errorId = error ? `${inputId}-error` : undefined;

    const classes = ["input", "textarea"];
    if (className) classes.push(className);

    return (
      <div className="field">
        {label && <label htmlFor={inputId}>{label}</label>}
        <textarea
          ref={ref}
          id={inputId}
          className={classes.join(" ")}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={errorId}
          style={
            autoGrow
              ? {
                  fieldSizing: "content" as React.CSSProperties["fieldSizing"],
                  ...style,
                }
              : style
          }
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
