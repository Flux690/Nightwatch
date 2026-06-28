import { Tooltip, UnstyledButton } from "@mantine/core";
import { Link, useRouterState } from "@tanstack/react-router";

// Rail/sidebar geometry. The icon slot (.nw-side-row__icon in styles.css) is
// RAIL_WIDTH - 2*NAV_PAD wide, so the icon centre sits at the same x in both
// states and never moves when the navbar width animates between them.
export const RAIL_WIDTH = 56;
export const EXPANDED_WIDTH = 250;
export const NAV_PAD = 8;

interface SideRowProps {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  to?: string;
  onClick?: () => void;
  primary?: boolean;
}

// One row used for every sidebar item in both rail and expanded states. The row
// element and its icon are identical across states - only the label is added and
// the width animates - so the icon never remounts or shifts. The label always
// supplies the accessible name via aria-label, so links/buttons stay reachable in
// the rail; the tooltip is shown only while collapsed.
export function SideRow({
  icon,
  label,
  expanded,
  to,
  onClick,
  primary,
}: SideRowProps): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active =
    to !== undefined && (pathname === to || pathname.startsWith(`${to}/`));

  const inner = (
    <>
      <span className="nw-side-row__icon">{icon}</span>
      {expanded && <span className="nw-side-row__label">{label}</span>}
    </>
  );

  const row =
    to !== undefined ? (
      <Link
        to={to}
        aria-label={label}
        className="nw-side-row"
        data-active={active || undefined}
      >
        {inner}
      </Link>
    ) : (
      <UnstyledButton
        aria-label={label}
        onClick={onClick}
        className="nw-side-row"
        data-primary={primary || undefined}
      >
        {inner}
      </UnstyledButton>
    );

  return (
    <Tooltip label={label} position="right" withArrow disabled={expanded}>
      {row}
    </Tooltip>
  );
}
