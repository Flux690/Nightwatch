import "./Table.css";

import React from "react";

export const Table = React.forwardRef<
  HTMLTableElement,
  React.ComponentPropsWithoutRef<"table">
>(function Table({ className, ...rest }, ref) {
  return (
    <table
      ref={ref}
      className={className ? `table ${className}` : "table"}
      {...rest}
    />
  );
});

export const TableHead = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentPropsWithoutRef<"thead">
>(function TableHead(props, ref) {
  return <thead ref={ref} {...props} />;
});

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.ComponentPropsWithoutRef<"tbody">
>(function TableBody(props, ref) {
  return <tbody ref={ref} {...props} />;
});

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.ComponentPropsWithoutRef<"tr">
>(function TableRow(props, ref) {
  return <tr ref={ref} {...props} />;
});

export const TableHeader = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentPropsWithoutRef<"th">
>(function TableHeader({ className, ...rest }, ref) {
  return (
    <th
      ref={ref}
      scope="col"
      className={className ? `table__th ${className}` : "table__th"}
      {...rest}
    />
  );
});

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.ComponentPropsWithoutRef<"td">
>(function TableCell({ className, ...rest }, ref) {
  return (
    <td
      ref={ref}
      className={className ? `table__td ${className}` : "table__td"}
      {...rest}
    />
  );
});
