"use client";

import { useMemo } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { cn } from "@/lib/utils";

const features = tableFeatures({});

export type GridColumn<T> = {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  hideBelow?: "sm" | "md" | "lg";
};

const HIDE = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" } as const;

/** Dense, keyboard-operable table (TanStack Table v9, core features only — paging/filtering are server-side). */
export function DataGrid<T extends object>({
  rows,
  columns,
  getRowId,
  onRowClick,
  rowLabel,
  className,
  stickyHeader = true,
}: {
  rows: T[];
  columns: GridColumn<T>[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  className?: string;
  stickyHeader?: boolean;
}) {
  const defs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return columns.map((c) =>
      helper.display({
        id: c.id,
        header: () => c.header,
        cell: (info) => c.cell(info.row.original as T),
      }),
    );
  }, [columns]);
  const table = useTable({ features, columns: defs, data: rows, getRowId: (r) => getRowId(r as T) });
  const meta = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  return (
    <div className={cn("scrollbar-thin overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead className={cn(stickyHeader && "sticky top-0 z-10 bg-card")}>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id} className="border-b">
              {g.headers.map((h) => {
                const m = meta.get(h.column.id);
                return (
                  <th
                    key={h.id}
                    scope="col"
                    className={cn(
                      "h-9 px-3 text-[11.5px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase first:pl-5 last:pr-5",
                      m?.align === "right" ? "text-right" : m?.align === "center" ? "text-center" : "text-left",
                      m?.hideBelow && HIDE[m.hideBelow],
                    )}
                  >
                    {h.isPlaceholder ? null : <table.FlexRender header={h} />}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const original = row.original as T;
            return (
              <tr
                key={row.id}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={rowLabel?.(original)}
                onClick={onRowClick ? () => onRowClick(original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(original);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "border-b border-border/60 transition-colors last:border-0",
                  onRowClick && "cursor-pointer hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none",
                )}
              >
                {row.getAllCells().map((cell) => {
                  const m = meta.get(cell.column.id);
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        "h-11 px-3 whitespace-nowrap first:pl-5 last:pr-5",
                        m?.align === "right" ? "text-right" : m?.align === "center" ? "text-center" : "text-left",
                        m?.hideBelow && HIDE[m.hideBelow],
                        m?.className,
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
