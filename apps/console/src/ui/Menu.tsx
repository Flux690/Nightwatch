import "./Menu.css";

import {
  Menu as MantineMenu,
  type MenuProps as MantineMenuProps,
  type MenuTargetProps as MantineMenuTargetProps,
  type MenuDropdownProps as MantineMenuDropdownProps,
  type MenuItemProps as MantineMenuItemProps,
} from "@mantine/core";

type MenuProps = Omit<MantineMenuProps, "unstyled" | "classNames"> & {
  children: React.ReactNode;
};

export function Menu({ children, ...props }: MenuProps): React.JSX.Element {
  return (
    <MantineMenu
      unstyled
      classNames={{
        dropdown: "menu__dropdown",
        item: "menu__item",
        itemLabel: "menu__item-label",
        divider: "menu__divider",
        label: "menu__label",
      }}
      {...props}
    >
      {children}
    </MantineMenu>
  );
}

export function MenuTarget(props: MantineMenuTargetProps): React.JSX.Element {
  return <MantineMenu.Target {...props} />;
}

export function MenuDropdown({
  children,
  ...props
}: MantineMenuDropdownProps): React.JSX.Element {
  return (
    <MantineMenu.Dropdown className="menu__dropdown" {...props}>
      {children}
    </MantineMenu.Dropdown>
  );
}

export function MenuItem(props: MantineMenuItemProps): React.JSX.Element {
  return <MantineMenu.Item className="menu__item" {...props} />;
}
