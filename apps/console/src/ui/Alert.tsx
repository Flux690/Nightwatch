import "./Alert.css";

import {
  Alert as MantineAlert,
  type AlertProps as MantineAlertProps,
} from "@mantine/core";

type AlertIntent = "info" | "success" | "warning" | "error";

type AlertProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title" | "color"
> & {
  title?: MantineAlertProps["title"];
  intent?: AlertIntent;
  withCloseButton?: boolean;
  closeButtonLabel?: string;
  onClose?: () => void;
  icon?: React.ReactNode;
};

export function Alert({
  intent = "info",
  className,
  ...props
}: AlertProps): React.JSX.Element {
  return (
    <MantineAlert
      classNames={{
        root: className
          ? `alert alert--${intent} ${className}`
          : `alert alert--${intent}`,
        title: "alert__title",
        body: "alert__body",
        message: "alert__message",
        closeButton: "alert__close",
        icon: "alert__icon",
        wrapper: "alert__wrapper",
      }}
      {...props}
    />
  );
}
