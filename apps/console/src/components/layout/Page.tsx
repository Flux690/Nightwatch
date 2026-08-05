import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Card } from "@/components/ui/card";
import { ICON_INLINE } from "@/lib/iconProps";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/* Warm Steel column headers: small, muted, upper-case across every data table. Apply as the Table className. */
export const TABLE_HEAD =
  "[&_thead_th]:text-sm [&_thead_th]:font-medium [&_thead_th]:uppercase [&_thead_th]:tracking-wider [&_thead_th]:text-muted-foreground";

/* Generic loading placeholder for data tables. Renders `count` rows of `columns` skeleton cells. */
export function SkeletonRows({
  count,
  columns,
}: {
  count: number;
  columns: number;
}): React.JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <TableRow key={i}>
          {Array.from({ length: columns }, (_, j) => (
            <TableCell key={j}>
              <Skeleton className="h-3.5 w-30" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/* Page shell for data screens (Fleet, Audit log, Unresolved alerts, Add server). Single max-width (--container-page), centered, column flow. */
export function Page({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      className={cn(
        "mx-auto flex min-h-full w-full max-w-page flex-col p-6 max-md:p-3 max-lg:px-4",
        className,
      )}
      {...props}
    />
  );
}

/* Header row: title left, actions right. */
export function PageHeader({
  className,
  ...props
}: React.ComponentProps<"header">): React.JSX.Element {
  return (
    <header
      className={cn(
        "mb-4 flex shrink-0 items-center justify-between",
        className,
      )}
      {...props}
    />
  );
}

export function PageTitle({
  className,
  ...props
}: React.ComponentProps<"h1">): React.JSX.Element {
  return (
    <h1
      className={cn(
        "m-0 text-2xl font-semibold tracking-[-0.3px] text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/* The way back up. The catalog is a page, not a rail that stays on screen. */
export function BackLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className="mb-2 inline-flex w-fit items-center gap-2 self-start rounded-sm text-sm text-muted-foreground no-underline hover:text-foreground"
    >
      <ArrowLeft {...ICON_INLINE} />
      {children}
    </Link>
  );
}

/* Bordered card wrapper for a data table. */
export function PageTableWrap({
  className,
  ...props
}: React.ComponentProps<typeof Card>): React.JSX.Element {
  return <Card className={cn("overflow-x-auto py-0", className)} {...props} />;
}
