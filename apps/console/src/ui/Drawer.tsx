import "./Drawer.css";

import {
  Drawer as MantineDrawer,
  type DrawerProps as MantineDrawerProps,
} from "@mantine/core";

type DrawerProps = Omit<MantineDrawerProps, "unstyled" | "classNames"> & {
  opened: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

export function Drawer({ children, ...props }: DrawerProps): React.JSX.Element {
  return (
    <MantineDrawer
      classNames={{
        body: "drawer__body",
        overlay: "drawer__overlay",
        content: "drawer__content",
      }}
      {...props}
    >
      {children}
    </MantineDrawer>
  );
}
