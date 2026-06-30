import "./Drawer.css";

import {
  Drawer as MantineDrawer,
  type DrawerProps as MantineDrawerProps,
} from "@mantine/core";

type DrawerProps = Omit<
  MantineDrawerProps,
  "unstyled" | "classNames" | "overlayProps"
> & {
  opened: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

export function Drawer({
  children,
  ...props
}: DrawerProps): React.JSX.Element {
  return (
    <MantineDrawer
      unstyled
      classNames={{
        root: "drawer",
        header: "drawer__header",
        body: "drawer__body",
        overlay: "drawer__overlay",
        content: "drawer__content",
        title: "drawer__title",
        close: "drawer__close",
      }}
      overlayProps={{
        style: { boxShadow: "var(--shadow-overlay)" },
      }}
      {...props}
    >
      {children}
    </MantineDrawer>
  );
}
