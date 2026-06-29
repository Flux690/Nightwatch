import {
  Tooltip as MantineTooltip,
  type TooltipProps as MantineTooltipProps,
} from "@mantine/core";

type TooltipProps = Omit<MantineTooltipProps, "unstyled" | "classNames"> & {
  label: string;
  children: React.ReactElement;
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
      }}
      {...props}
    >
      {children}
    </MantineTooltip>
  );
}
