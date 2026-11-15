// The admin's tables, inside a Card: a muted header row of small labels,
// 56 px rows divided by borders, 20 px side padding, 16 px between columns.
import { Table, type TableCellProps, type TableColumnHeaderProps } from "@chakra-ui/react";
import type { ReactNode } from "react";

/** The table itself; put DataHeader and DataRow cells in Table.Header and Table.Body. */
export function DataTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Table.Root aria-label={label} size="sm" variant="line" bg="transparent" css={{ borderCollapse: "collapse" }}>
      {children}
    </Table.Root>
  );
}

const SIDE = { "&:first-of-type": { ps: "5" }, "&:last-of-type": { pe: "5" } };

/** A column title. */
export function DataHeader(props: TableColumnHeaderProps) {
  return (
    <Table.ColumnHeader
      bg="bg.muted"
      color="fg.subtle"
      textStyle="label-xs"
      py="2"
      px="2"
      borderColor="border"
      css={SIDE}
      {...props}
    />
  );
}

/** A body cell; `muted` for secondary values. */
export function DataCell({ muted, ...props }: TableCellProps & { muted?: boolean }) {
  return (
    <Table.Cell
      h="14"
      py="0"
      px="2"
      textStyle="text-sm"
      color={muted ? "fg.muted" : "fg"}
      borderColor="border"
      css={SIDE}
      {...props}
    />
  );
}
