import { Tooltip } from "../ui/Tooltip.js";
import { UnstyledButton } from "../ui/UnstyledButton.js";
import { Link, useRouterState } from "@tanstack/react-router";

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
      {expanded && <span className="side-row__label">{label}</span>}
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
      <UnstyledButton
        aria-label={label}
        onClick={onClick}
        className="side-row"
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
