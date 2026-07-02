import "./Button.css";

import {
  Button as MantineButton,
  type ButtonProps as MantineButtonProps,
} from "@mantine/core";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "xs";

type ButtonProps = Omit<React.ComponentPropsWithoutRef<"button">, "color"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftSection?: MantineButtonProps["leftSection"];
};

export function Button({
  variant = "primary",
  size = "default",
  loading,
  className,
  disabled,
  leftSection,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <MantineButton
      classNames={{
        root: className ? `btn ${className}` : "btn",
        inner: "btn__inner",
        label: "btn__label",
        section: "btn__section",
        loader: "btn__loader",
      }}
      data-variant={variant}
      data-size={size !== "default" ? size : undefined}
      aria-busy={loading ? "true" : undefined}
      disabled={loading || disabled}
      loading={loading}
      leftSection={leftSection}
      {...rest}
    />
  );
}
