import { Tooltip } from "../ui/Tooltip.js";
import { Button } from "../ui/Button.js";
import { Link, useRouterState } from "@tanstack/react-router";

export const RAIL_WIDTH = 56;
export const EXPANDED_WIDTH = 260;
export const NAV_PAD = 8;

interface SideRowProps {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  to?: string;
  onClick?: () => void;
  primary?: boolean;
}

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
      <span className="side-row__icon">{icon}</span>
      <span className="side-row__label" data-hidden={expanded ? undefined : ""}>
        {label}
      </span>
    </>
  );

  const row =
    to !== undefined ? (
      <Link
        to={to}
        aria-label={label}
        className="side-row"
        data-active={active || undefined}
      >
        {inner}
      </Link>
    ) : (
      <Button
        variant="plain"
        aria-label={label}
        onClick={onClick}
        className="side-row"
        data-primary={primary || undefined}
      >
        {inner}
      </Button>
    );

  return (
    <li className="side-row__li">
      <Tooltip label={label} position="right" withArrow disabled={expanded}>
        {row}
      </Tooltip>
    </li>
  );
}
