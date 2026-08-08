import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";

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

/* The one page shell, and the only one. `measure` names the page's own column
   from the container block in styles.css. "full" keeps the stage's padding and
   drops the column, which is what a list of one-line rows wants; "none" gives
   up the padding too, which is what a report beside a rail needs. */
export function Page({
  crumbs,
  beside,
  controls,
  measure = "page",
  children,
}: {
  crumbs: Crumb[];
  /* Rides the crumbs rather than the far edge: a control that belongs to the
     thing named sits after its name, wherever that name happens to end. */
  beside?: React.ReactNode;
  controls?: React.ReactNode;
  measure?: "page" | "form" | "full" | "none";
  children?: React.ReactNode;
}): React.JSX.Element {
  const { isOverlay, openOverlay, toggleSidebar } = useSidebar();
  return (
    <div className="flex min-h-full w-full min-w-0 flex-col">
      {/* Padding rides the rows, not the bar, so the divider runs the full
          width of the stage. */}
      <header className="shrink-0">
        <div className="flex h-12 items-center gap-1 border-b border-border px-6 max-lg:px-4">
          {/* A panel that is fully off screen cannot host the control that
              reopens it, so the bar it left behind carries it instead. */}
          {isOverlay && !openOverlay && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle sidebar"
              aria-expanded={false}
              className="-ml-1 shrink-0 text-muted-foreground"
              onClick={() => toggleSidebar()}
            >
              <PanelLeft className="size-4.5" strokeWidth={1.5} aria-hidden />
            </Button>
          )}
          {/* The two header grammars are exclusive: a page that discloses the
              collection it belongs to says where it is that way instead. */}
          {crumbs.length > 0 && (
            <Breadcrumb className="min-w-0">
              {/* The ceiling a long title truncates against, so what sits beside
                it has somewhere to be. */}
              <BreadcrumbList className="max-w-md flex-nowrap text-sm font-medium">
                {crumbs.map((crumb, i) => (
                  <Fragment key={crumb.label}>
                    {i > 0 && <BreadcrumbSeparator />}
                    {/* Only the last crumb gives way. The ones before it name
                        the collection, and a collection cut to "Investi…" tells
                        the operator less than the title it was protecting. */}
                    <BreadcrumbItem
                      className={
                        i === crumbs.length - 1 ? "min-w-0" : "shrink-0"
                      }
                    >
                      {/* font-medium beats the page part's own font-normal. */}
                      {crumb.to === undefined ? (
                        <BreadcrumbPage className="truncate font-medium">
                          {crumb.label}
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          className="whitespace-nowrap no-underline"
                          /* Exact, or an ancestor crumb claims aria-current
                           alongside the entry that really is the page. */
                          render={
                            <Link
                              to={crumb.to}
                              activeOptions={{ exact: true }}
                            />
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
          )}
          {beside}
        </div>
        {/* Grouped, not a toolbar: the row also carries readouts. The size is
            set here so the whole bar reads at one step, whatever fills it. */}
        {controls !== undefined && (
          <div
            role="group"
            aria-label="Page controls"
            className="flex min-h-12 items-center justify-between gap-3 px-6 text-sm max-lg:px-4"
          >
            {controls}
          </div>
        )}
      </header>
      {measure === "none" ? (
        children
      ) : (
        <div
          className={cn(
            "flex w-full flex-1 flex-col p-6 max-lg:px-4",
            measure === "form" && "mx-auto max-w-form",
            measure === "page" && "mx-auto max-w-page",
          )}
        >
          {children}
        </div>
      )}
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
