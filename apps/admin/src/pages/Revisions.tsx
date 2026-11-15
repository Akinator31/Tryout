// The revisions page, from the Figma "Revisions" screen: every revision,
// newest first, and the chosen one's changes from its parent, its YAML, and
// rolling back to it.
import { Box, Button, Flex, Heading, Stack, Table, Text } from "@chakra-ui/react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { useNow } from "../clock.ts";
import { Card } from "../components/Card.tsx";
import { DataCell, DataHeader, DataTable } from "../components/DataTable.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { DownloadButton } from "../components/DownloadButton.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { daysAgo } from "../format.ts";
import type { RevisionSummary } from "../model.ts";
import { paths } from "../navigation.ts";
import { useRevision, useRevisions, useRollback } from "../queries.ts";
import { downloadLogo, downloadSettings } from "../settings/download.ts";
import { settingsRefusal } from "../settings/refusals.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

const R = strings.revisions;
const MINUTE = 60_000;

/** One revision's row; the chosen one is highlighted, the newest marked active. */
function RevisionRow(props: { revision: RevisionSummary; active: boolean; chosen: boolean; now: number; onOpen: () => void }) {
  const { revision, active, chosen, now, onOpen } = props;

  return (
    <Table.Row bg={chosen ? "bg.emphasized" : "transparent"} cursor="pointer" _hover={{ bg: chosen ? undefined : "bg.muted" }} onClick={onOpen}>
      <DataCell w="72px" textStyle="mono-sm">
        {revision.id}
      </DataCell>
      <DataCell>
        <Flex gap="2" align="center" minW="0">
          <Text truncate maxW="260px">
            {revision.note ?? strings.common.none}
          </Text>
          {active && (
            <Text as="span" px="2" borderRadius="l1" bg="brand.subtle" color="brand.fg" textStyle="label-xs" flexShrink="0">
              {R.active}
            </Text>
          )}
        </Flex>
      </DataCell>
      <DataCell w="140px" muted>
        <Text truncate maxW="124px" title={revision.author}>
          {revision.author}
        </Text>
      </DataCell>
      <DataCell w="130px" muted>
        {daysAgo(revision.createdAt, now)}
      </DataCell>
      <DataCell w="48px" textAlign="end">
        <Button
          variant="ghost"
          size="xs"
          aria-label={R.open(revision.id)}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <ChevronRight size={16} aria-hidden />
        </Button>
      </DataCell>
    </Table.Row>
  );
}

/** Why a rollback was refused, in words. */
function rollbackProblem(refusal: ReturnType<typeof settingsRefusal>): string {
  if (refusal?.kind === "moved") return R.detail.moved;
  if (refusal?.kind === "nodeInUse") return strings.review.nodeInUse(refusal.nodes);
  if (refusal?.kind === "invalid") return strings.review.invalid;
  return strings.common.actionFailed;
}

/** The chosen revision: its changes from its parent, downloads, and rollback. */
function RevisionDetail({ id, latest, now }: { id: number; latest: number; now: number }) {
  const revision = useRevision(id);
  const parent = useRevision(revision.data?.parent ?? null);
  const rollback = useRollback();
  const { draft } = useDraft();

  if (revision.isError) return <Problem title={strings.common.loadFailed} detail={revision.error.message} />;
  if (!revision.data) return <Text color="fg.muted">{strings.common.loading}</Text>;

  const r = revision.data;
  const before = r.parent === null ? {} : parent.data?.document;
  const isActive = r.id === latest;
  const refusal = settingsRefusal(rollback.error);
  const asset = r.document.theme?.logo?.asset;

  return (
    <Card>
      <Box px="5" py="4" borderBottomWidth="1px" borderColor="border">
        <Heading as="h2" textStyle="heading-md">
          {R.detail.title(r.id)}
        </Heading>
        <Text mt="1" textStyle="text-xs" color="fg.subtle">
          {[r.note, R.detail.meta(r.author, daysAgo(r.createdAt, now), r.parent)].filter(Boolean).join(" ")}
        </Text>
      </Box>

      <Stack px="5" py="4" gap="3" borderBottomWidth="1px" borderColor="border">
        <Text textStyle="text-xs" color="fg.subtle">
          {R.detail.changesFrom(r.parent)}
        </Text>
        {before ? <DiffView before={before} after={r.document} label={R.detail.diffLabel} empty={R.detail.same} /> : <Text color="fg.muted">{strings.common.loading}</Text>}
        <Flex gap="2" wrap="wrap">
          <DownloadButton label={R.detail.download} run={() => downloadSettings(r.document, r.id, R.detail.source(r.id))} />
          {asset && <DownloadButton label={R.detail.downloadLogo} run={() => downloadLogo(asset)} />}
        </Flex>
      </Stack>

      <Stack px="5" py="4" gap="3">
        {isActive ? (
          <Text textStyle="text-xs" color="fg.subtle">
            {R.detail.isActive}
          </Text>
        ) : (
          <>
            <Text textStyle="text-xs" color="fg.subtle">
              {draft ? R.detail.draftPending : R.detail.rollbackHelp(r.id, latest + 1)}
            </Text>
            {rollback.isError && <Problem title={rollbackProblem(refusal)} detail={refusal?.kind === "invalid" ? refusal.problems.join(" ") : undefined} />}
            <Box>
              <Button variant="outline" size="sm" h="10" disabled={draft !== null} loading={rollback.isPending} onClick={() => rollback.mutate({ id: r.id, base: latest })}>
                <RotateCcw size={16} aria-hidden />
                {R.detail.rollback(r.id)}
              </Button>
            </Box>
          </>
        )}
      </Stack>
    </Card>
  );
}

/** The revisions page; `/admin/revisions/:id` shows that revision, else the newest. */
export function Revisions() {
  const revisions = useRevisions();
  const navigate = useNavigate();
  const now = useNow(MINUTE);
  const params = useParams();

  const list = revisions.data ?? [];
  const latest = list[0];
  const chosen = params.id ? Number(params.id) : (latest?.id ?? null);

  return (
    <>
      <PageHeader title={R.title} description={R.description} action={<PendingActions />} />

      <Box px="8">
        {revisions.isError && <Problem title={strings.common.loadFailed} detail={revisions.error.message} />}
        {revisions.data && (
          <Text mb="6" color="fg.muted">
            {latest ? R.summary(latest.id, latest.author, daysAgo(latest.createdAt, now)) : R.none}
          </Text>
        )}
      </Box>

      {latest && (
        <Flex px="8" gap="6" align="flex-start">
          <Card flex="1" minW="0">
            <DataTable label={R.title}>
              <Table.Header>
                <Table.Row bg="transparent">
                  <DataHeader>{R.columns.id}</DataHeader>
                  <DataHeader>{R.columns.note}</DataHeader>
                  <DataHeader>{R.columns.author}</DataHeader>
                  <DataHeader>{R.columns.published}</DataHeader>
                  <DataHeader />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {list.map((r) => (
                  <RevisionRow key={r.id} revision={r} active={r.id === latest.id} chosen={r.id === chosen} now={now} onOpen={() => navigate(`${paths.revisions}/${r.id}`)} />
                ))}
              </Table.Body>
            </DataTable>
          </Card>
          <Box w="520px" flexShrink="0">
            {chosen !== null && Number.isSafeInteger(chosen) && <RevisionDetail key={chosen} id={chosen} latest={latest.id} now={now} />}
          </Box>
        </Flex>
      )}
    </>
  );
}
