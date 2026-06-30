import "./AppShell.css";

import {
  AppShell as MantineAppShell,
  type AppShellProps as MantineAppShellProps,
} from "@mantine/core";

type AppShellProps = {
  navbar?: MantineAppShellProps["navbar"];
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

export function AppShell({
  className,
  ...props
}: AppShellProps): React.JSX.Element {
  return (
    <MantineAppShell
      unstyled
      classNames={{
        root: className ? `app-shell ${className}` : "app-shell",
        navbar: "app-shell__navbar",
        main: "app-shell__main",
      }}
      {...props}
    />
  );
}

type AppShellNavbarProps = React.HTMLAttributes<HTMLElement>;

export function AppShellNavbar(props: AppShellNavbarProps): React.JSX.Element {
  return <MantineAppShell.Navbar {...props} />;
}

type AppShellMainProps = React.HTMLAttributes<HTMLElement>;

export function AppShellMain(props: AppShellMainProps): React.JSX.Element {
  return <MantineAppShell.Main {...props} />;
}
