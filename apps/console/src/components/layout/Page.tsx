import { Fragment } from "react";
import { Link } from "@tanstack/react-router";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/* Warm Steel column headers: small, muted, upper-case across every data table. Apply as the Table className. */
export const TABLE_HEAD =
  "[&_thead_th]:text-sm [&_thead_th]:font-medium [&_thead_th]:uppercase [&_thead_th]:tracking-wider [&_thead_th]:text-muted-foreground";

export const SECTION_HEADING =
  "font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground";

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

/* One entry per level, root first. The last is where you are and never links;
   a lone entry is the page title, so the chevron appears only on descent. */
export interface Crumb {
  label: string;
  to?: string;
}

/* The one page shell: a bar carrying the breadcrumb, a divider, and a controls
   row on the pages that have controls. The bar spans the stage; the body keeps
   the reading measure. */
export function Page({
  crumbs,
  controls,
  measure = "page",
  children,
}: {
  crumbs: Crumb[];
  controls?: React.ReactNode;
  /* Tables and lists take the page's full measure; forms and card grids read
     better narrow, which is also what puts three cards across a row. */
  measure?: "page" | "form";
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full w-full flex-col">
      {/* Padding rides the rows, not the bar, so the divider runs the full
          width of the stage. The pad below lg seats the sidebar toggle. */}
      <header className="shrink-0">
        <div className="flex h-12 items-center border-b border-border px-6 max-lg:px-4 max-lg:pl-12">
          <Breadcrumb>
            <BreadcrumbList className="text-base font-medium">
              {crumbs.map((crumb, i) => (
                <Fragment key={crumb.label}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className="min-w-0">
                    {/* font-medium beats the page part's own font-normal. */}
                    {crumb.to === undefined ? (
                      <BreadcrumbPage className="truncate font-medium">
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="truncate no-underline"
                        /* Exact, or an ancestor crumb claims aria-current
                           alongside the entry that really is the page. */
                        render={
                          <Link to={crumb.to} activeOptions={{ exact: true }} />
                        }
                      >
                        {crumb.label}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        {/* Grouped, not a toolbar: the row also carries readouts. */}
        {controls !== undefined && (
          <div
            role="group"
            aria-label="Page controls"
            className="flex min-h-12 items-center justify-between gap-3 px-6 max-lg:px-4"
          >
            {controls}
          </div>
        )}
      </header>
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col p-6 max-lg:px-4",
          measure === "form" ? "max-w-form" : "max-w-page",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* Bordered card wrapper for a data table. */
export function PageTableWrap({
  className,
  ...props
}: React.ComponentProps<typeof Card>): React.JSX.Element {
  return <Card className={cn("overflow-x-auto py-0", className)} {...props} />;
}
