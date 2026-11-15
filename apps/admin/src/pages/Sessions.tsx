// The sessions page, from the Figma "Sessions" and "Sessions — stop dialog" screens.
import { Box, Button, Table, Text } from "@chakra-ui/react";
import { Square } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../api.ts";
import { useNow } from "../clock.ts";
import { Card, Footnote } from "../components/Card.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { DataCell, DataHeader, DataTable } from "../components/DataTable.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Problem } from "../components/Problem.tsx";
import { StateBadge } from "../components/StateBadge.tsx";
import { slots } from "../format.ts";
import { useActiveSettings, useSessions, useStopSession } from "../queries.ts";
import { sessionRow, sessionsSummary, type SessionRow } from "../sessions.ts";
import { strings } from "../strings.ts";

const S = strings.sessions;

/** One ticket's row, with its Stop button. */
function Row({ row, onStop }: { row: SessionRow; onStop: () => void }) {
  return (
    <Table.Row bg="transparent">
      <DataCell w="100px" fontFamily="mono" textStyle="mono-sm">
        {row.label}
      </DataCell>
      <DataCell w="160px">{row.project}</DataCell>
      <DataCell w="100px" muted>
        {row.node}
      </DataCell>
      <DataCell w="140px">
        <StateBadge state={row.state} label={row.stateLabel} />
      </DataCell>
      <DataCell w="120px" muted>
        {row.waitingSince}
      </DataCell>
      <DataCell w="120px" muted>
        {row.started}
      </DataCell>
      <DataCell w="90px" muted fontVariantNumeric="tabular-nums">
        {row.timeLeft}
      </DataCell>
      <DataCell textAlign="end">
        <Button variant="outline" size="sm" h="8" px="3" aria-label={S.stopLabel(row.label)} onClick={onStop}>
          <Square size={16} aria-hidden />
          {S.stop}
        </Button>
      </DataCell>
    </Table.Row>
  );
}

/** Asks before stopping `row`'s session; a 404 means it ended meanwhile. */
function StopDialog({ row, onClose }: { row: SessionRow | null; onClose: () => void }) {
  const stop = useStopSession();
  const gone = stop.error instanceof ApiError && stop.error.status === 404;

  /** Closes the dialog and forgets the last attempt. */
  const close = () => {
    stop.reset();
    onClose();
  };

  return (
    <ConfirmDialog
      open={row !== null}
      title={row ? S.dialog.title(row.label) : ""}
      context={row ? S.dialog.context(row.project, row.node, row.started === strings.common.none ? null : row.started) : undefined}
      confirmLabel={S.dialog.confirm}
      confirmIcon={<Square size={16} aria-hidden />}
      pending={stop.isPending}
      onConfirm={() => row && stop.mutate(row.ticket, { onSuccess: close })}
      onClose={close}
    >
      <Text>{S.dialog.body}</Text>
      {stop.isError && <Problem title={gone ? S.dialog.gone : strings.common.actionFailed} />}
    </ConfirmDialog>
  );
}

/** Every live ticket, refreshed every 3 s, with the operator's stop. */
export function Sessions() {
  const sessions = useSessions();
  const settings = useActiveSettings();
  const now = useNow();
  const [stopping, setStopping] = useState<SessionRow | null>(null);

  const capacity = settings.data ? slots(settings.data.document) : null;
  const rows = (sessions.data ?? []).map((s) => sessionRow(s, now));

  return (
    <>
      <PageHeader title={S.title} description={S.description} />

      <Box px="8">
        {sessions.isError && !sessions.data && <Problem title={strings.common.loadFailed} detail={sessions.error.message} />}

        {sessions.data && (
          <>
            <Text color="fg.muted" mb="6">
              {sessionsSummary(sessions.data, capacity)}
            </Text>
            <Card>
              <DataTable label={S.title}>
                <Table.Header>
                  <Table.Row bg="transparent">
                    <DataHeader>{S.columns.ticket}</DataHeader>
                    <DataHeader>{S.columns.project}</DataHeader>
                    <DataHeader>{S.columns.node}</DataHeader>
                    <DataHeader>{S.columns.state}</DataHeader>
                    <DataHeader>{S.columns.waitingSince}</DataHeader>
                    <DataHeader>{S.columns.started}</DataHeader>
                    <DataHeader>{S.columns.timeLeft}</DataHeader>
                    <DataHeader>
                      <Box srOnly>{S.columns.actions}</Box>
                    </DataHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Row key={row.ticket} row={row} onStop={() => setStopping(row)} />
                  ))}
                  {rows.length === 0 && (
                    <Table.Row bg="transparent">
                      <DataCell colSpan={8} muted>
                        {S.empty}
                      </DataCell>
                    </Table.Row>
                  )}
                </Table.Body>
              </DataTable>
              <Footnote>{S.footnote}</Footnote>
            </Card>
          </>
        )}
      </Box>

      <StopDialog row={stopping} onClose={() => setStopping(null)} />
    </>
  );
}
