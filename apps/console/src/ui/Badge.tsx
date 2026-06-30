import "./Badge.css";

import { Badge as MantineBadge } from "@mantine/core";

type BadgeIntent = "info" | "success" | "warning" | "error" | "neutral";

type BadgeProps = {
  intent?: BadgeIntent;
  className?: string;
  children: React.ReactNode;
};

export function Badge({
  intent = "neutral",
  className,
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <MantineBadge
      unstyled
      classNames={{
        root: className
          ? `badge badge--${intent} ${className}`
          : `badge badge--${intent}`,
        label: "badge__label",
      }}
      {...props}
    />
  );
}
