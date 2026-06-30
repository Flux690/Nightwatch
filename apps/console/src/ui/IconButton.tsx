import "./IconButton.css";

import { ActionIcon as MantineActionIcon } from "@mantine/core";

type IconButtonProps = {
  "aria-label": string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  children: React.ReactNode;
};

export function IconButton({
  className,
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <MantineActionIcon
      unstyled
      classNames={{
        root: className ? `icon-btn ${className}` : "icon-btn",
        loader: "icon-btn__loader",
      }}
      {...props}
    />
  );
}
