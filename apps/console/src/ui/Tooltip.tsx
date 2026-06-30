import "./Tooltip.css";

import {
  Tooltip as MantineTooltip,
  type TooltipProps as MantineTooltipProps,
} from "@mantine/core";

type TooltipProps = {
  label: string;
  children: React.ReactElement;
  position?: MantineTooltipProps["position"];
  withArrow?: boolean;
  disabled?: boolean;
};

export function Tooltip({
  children,
  ...props
}: TooltipProps): React.JSX.Element {
  return (
    <MantineTooltip
      unstyled
      classNames={{
        tooltip: "tooltip",
        arrow: "tooltip__arrow",
      }}
      {...props}
    >
      {children}
    </MantineTooltip>
  );
}
