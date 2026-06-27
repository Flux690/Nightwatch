import { Tooltip } from "@mantine/core";
import { Link, useRouterState } from "@tanstack/react-router";

// A sidebar navigation link that highlights when its route (or a child route) is
// active. Collapses to an icon-only, tooltipped target when the sidebar is compact.
export function NavLink({
  to,
  icon,
  label,
  compact,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  compact: boolean;
}): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);

  const linkStyle = {
    display: "flex",
    alignItems: "center",
    borderRadius: "var(--mantine-radius-sm)",
    color: active ? "var(--nw-accent)" : "var(--nw-text-muted)",
    background: active ? "var(--nw-surface-raised)" : "transparent",
    textDecoration: "none",
  };

  if (compact) {
    return (
      <Tooltip label={label} position="right" withArrow>
        <Link
          to={to}
          aria-label={label}
          style={{
            ...linkStyle,
            justifyContent: "center",
            width: 40,
            height: 36,
          }}
        >
          {icon}
        </Link>
      </Tooltip>
    );
  }

  return (
    <Link
      to={to}
      style={{
        ...linkStyle,
        gap: 8,
        padding: "6px var(--mantine-spacing-xs)",
        fontWeight: active ? 600 : 400,
        fontSize: 13,
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
