import "./IconButton.css";

import React from "react";

type IconButtonVariant = "default" | "ghost";

type IconButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  variant?: IconButtonVariant;
  "aria-label": string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ variant = "default", className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={className ? `icon-btn ${className}` : "icon-btn"}
        data-variant={variant}
        {...rest}
      />
    );
  },
);
