// A project's page, from the Figma "Project — cli-hello" and "Project —
// cli-hello paused" screens, on one page: its load, live sessions and
// settings, with pause, edit and remove. Pause and remove change the draft and
// open the review. The right column previews and embeds it (ProjectEmbed.tsx).
import { Box, Button, Flex, Grid, Heading, Stack, Table, Text } from "@chakra-ui/react";
import { Pause, Play, SlidersHorizontal, Trash2 } from "lucide-react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { useNow } from "../clock.ts";
import { Breadcrumb } from "../components/Breadcrumb.tsx";
import { Callout } from "../components/Callout.tsx";
import { Card, Footnote } from "../components/Card.tsx";
import { DataCell, DataHeader, DataTable } from "../components/DataTable.tsx";
import { LoadBar } from "../components/LoadBar.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { ProjectBadge, StateBadge, TagBadge } from "../components/StateBadge.tsx";
import { editProjectPath, paths } from "../navigation.ts";
import { live, loadBy, loadOf, nodesUp, projectState, resources, type Load } from "../projects.ts";
import { useMe, useNodes, useSessions } from "../queries.ts";
import { deepEqual, type ProjectSettings, type SettingsDocument } from "../settings/document.ts";
import { sessionRow } from "../sessions.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";
import { EmbedCard, PreviewCard } from "./ProjectEmbed.tsx";

const P = strings.project;

/** A figure with its caption, and a bar when it has a cap. */
function Stat({ label, value, help, used, max }: { label: string; value: string; help: string; used?: number; max?: number }) {
  return (
    <Card p="5">
      <Text textStyle="text-xs" color="fg.muted">
        {label}
      </Text>
      <Text mt="2" textStyle="heading-lg" fontVariantNumeric="tabular-nums">
        {value}
      </Text>
      {max !== undefined && <LoadBar used={used ?? 0} max={max} w="full" />}
      <Text mt="3" textStyle="text-xs" color="fg.subtle">
        {help}
      </Text>
    </Card>
  );
}

/** The project's sessions, its queue, and its node's sessions out of the node's cap. */
function Stats({ project, load, nodeLoad, nodeCap }: { project: ProjectSettings; load: Load; nodeLoad: Load; nodeCap: number }) {
  const S = P.stats;

  return (
    <Grid templateColumns="repeat(3, 1fr)" gap="4">
      <Stat label={S.sessions} value={`${live(load)} / ${project.max_sessions}`} help={S.sessionsHelp} used={live(load)} max={project.max_sessions} />
      <Stat label={S.queue} value={String(load.waiting)} help={load.waiting ? S.waiting(load.waiting) : S.nobody} />
      <Stat label={S.node(project.node)} value={`${live(nodeLoad)} / ${nodeCap}`} help={S.nodeHelp} used={live(nodeLoad)} max={nodeCap} />
    </Grid>
  );
}

/** The project's live tickets. */
function LiveSessions({ name }: { name: string }) {
  const L = P.live;
  const now = useNow();
  const rows = (useSessions().data ?? []).filter((s) => s.project === name).map((s) => sessionRow(s, now));

  return (
    <Card as="section" aria-label={L.title}>
      <Heading as="h2" textStyle="heading-md" px="5" py="4" borderBottomWidth="1px" borderColor="border">
        {L.title}
      </Heading>
      <DataTable label={L.title}>
        <Table.Header>
          <Table.Row bg="transparent">
            {Object.values(L.columns).map((c) => (
              <DataHeader key={c}>{c}</DataHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={row.ticket} bg="transparent">
              <DataCell textStyle="mono-sm">{row.label}</DataCell>
              <DataCell>
                <StateBadge state={row.state} label={row.stateLabel} />
              </DataCell>
              <DataCell muted>{row.started}</DataCell>
              <DataCell muted fontVariantNumeric="tabular-nums">
                {row.timeLeft}
              </DataCell>
            </Table.Row>
          ))}
          {rows.length === 0 && (
            <Table.Row bg="transparent">
              <DataCell colSpan={4} muted>
                {L.empty}
              </DataCell>
            </Table.Row>
          )}
        </Table.Body>
      </DataTable>
      <Footnote>{L.footnote}</Footnote>
    </Card>
  );
}

/** The project's settings as key and value rows, in the order of tryout.yaml. */
function settingsRows(p: ProjectSettings, defaultRuntime: string | undefined): [string, string][] {
  const S = P.settings;
  const r = resources(p);
  const env = Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`);

  return [
    ...(p.enabled === false ? [["enabled", "false"] as [string, string]] : []),
    ...(p.title ? [["title", p.title] as [string, string]] : []),
    ["image", p.image],
    ["kind", p.kind],
    ["port", String(p.port)],
    ...(p.strip_prefix ? [["strip_prefix", "true"] as [string, string]] : []),
    ["max_sessions", String(p.max_sessions)],
    ["max_age", p.max_age],
    ["runtime", p.runtime ?? S.nodeDefault(defaultRuntime)],
    ["limits", S.limits(r.memory_mb, r.cpus, r.pids, r.defaults)],
    ["env", env.length ? env.join("\n") : strings.common.none],
  ];
}

/** The settings card; its header says whether they include pending changes. */
function SettingsCard({ rows, source }: { rows: [string, string][]; source: string }) {
  return (
    <Card as="section" aria-label={P.settings.title}>
      <Flex px="5" py="4" align="center" borderBottomWidth="1px" borderColor="border">
        <Heading as="h2" textStyle="heading-md" flex="1">
          {P.settings.title}
        </Heading>
        <Text textStyle="text-xs" color="fg.subtle">
          {source}
        </Text>
      </Flex>
      <Grid as="dl" templateColumns="160px 1fr" px="5" py="4" rowGap="1" textStyle="mono-sm">
        {rows.map(([key, value]) => (
          <Box key={key} display="contents">
            <Text as="dt" color="fg.subtle" py="0.5" borderBottomWidth="1px" borderColor="border">
              {key}
            </Text>
            <Text as="dd" whiteSpace="pre-wrap" wordBreak="break-all" py="0.5" borderBottomWidth="1px" borderColor="border">
              {value}
            </Text>
          </Box>
        ))}
      </Grid>
    </Card>
  );
}

/** The red card that removes the project, through the review. */
function RemoveCard({ name, onRemove }: { name: string; onRemove: () => void }) {
  const R = P.remove;

  return (
    <Card p="5" borderColor="border.error">
      <Text textStyle="label-sm" color="fg.error">
        {R.title}
      </Text>
      <Text mt="2" textStyle="text-xs" color="fg.muted">
        {R.body(name)}
      </Text>
      <Button mt="4" colorPalette="red" variant="surface" size="sm" h="9" onClick={onRemove}>
        <Trash2 size={16} aria-hidden />
        {R.action(name)}
      </Button>
    </Card>
  );
}

interface HeaderProps {
  name: string;
  project: ProjectSettings;
  state: ReturnType<typeof projectState>;
  onPause: (paused: boolean) => void;
}

/** The project's name, state and kind, its image line, and its actions. */
function Header({ name, project, state, onPause }: HeaderProps) {
  const paused = project.enabled === false;

  return (
    <Flex as="header" px="8" py="6" gap="4" align="flex-start">
      <Box flex="1" minW="0">
        <Flex gap="3" align="center">
          <Heading as="h1" textStyle="heading-2xl">
            {name}
          </Heading>
          <ProjectBadge state={state} />
          <TagBadge>{strings.projects.kinds[project.kind]}</TagBadge>
        </Flex>
        <Text mt="1" color="fg.muted" truncate>
          {P.subtitle(project.image, project.node, project.port)}
        </Text>
      </Box>
      <Flex gap="2" pt="1">
        <PendingActions />
        <Button variant="ghost" size="sm" h="10" onClick={() => onPause(!paused)}>
          {paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}
          {paused ? P.resume : P.pause}
        </Button>
        <Button asChild colorPalette="brand" size="sm" h="10">
          <RouterLink to={editProjectPath(name)}>
            <SlidersHorizontal size={16} aria-hidden />
            {P.edit}
          </RouterLink>
        </Button>
      </Flex>
    </Flex>
  );
}

/** The page of a project that is in the settings shown. */
function ProjectPage({ name, project, document, applied }: { name: string; project: ProjectSettings; document: SettingsDocument; applied: SettingsDocument | undefined }) {
  const navigate = useNavigate();
  const { edit, openReview, changes, active } = useDraft();
  const sessions = useSessions().data ?? [];
  const nodes = useNodes().data;
  const me = useMe().data;

  const load = loadOf(loadBy(sessions), name);
  const nodeLoad = loadOf(loadBy(sessions, "node"), project.node);
  // The state is what visitors get now: the active revision's project, not the draft's.
  const running = applied?.projects?.[name];
  const isApplied = running !== undefined;
  const state = projectState({ project: running ?? project, applied: isApplied, nodeUp: nodesUp(nodes).get((running ?? project).node), load });
  const pending = changes.length > 0 && !deepEqual(applied?.projects?.[name], project);
  const defaultRuntime = nodes?.find((n) => n.name === project.node)?.agent?.default_runtime;

  /** Pauses or resumes the project in the draft, then opens the review. */
  const pause = (paused: boolean) => {
    edit((d) => {
      const p = d.projects?.[name];
      if (p) p.enabled = paused ? false : undefined;
    });
    openReview();
  };

  /** Removes the project from the draft, back on the projects list, and opens the review. */
  const remove = () => {
    edit((d) => {
      delete d.projects?.[name];
    });
    navigate(paths.projects);
    openReview();
  };

  return (
    <>
      <Breadcrumb parent={P.breadcrumb} to={paths.projects} current={name} />
      <Header name={name} project={project} state={state} onPause={pause} />

      <Flex px="8" gap="6" align="flex-start">
        <Stack flex="1" minW="0" gap="6">
          {!isApplied && <Callout title={P.draft.title}>{P.draft.body}</Callout>}
          {running?.enabled === false && <Callout title={P.paused.title}>{P.paused.body}</Callout>}
          <Stats project={project} load={load} nodeLoad={nodeLoad} nodeCap={document.nodes?.[project.node]?.max_sessions ?? 0} />
          <LiveSessions name={name} />
          <SettingsCard rows={settingsRows(project, defaultRuntime)} source={pending ? P.settings.pending : P.settings.active(active.data?.revision ?? null)} />
        </Stack>
        <Stack w="420px" flexShrink="0" gap="6">
          <PreviewCard
            key={name}
            name={name}
            slots={(running ?? project).max_sessions}
            input={{
              publicUrl: me?.public_url ?? null,
              preview: me?.preview ?? false,
              applied: isApplied,
              paused: running?.enabled === false,
              // The embed page answers with the active revision's allowlist, not the draft's.
              ancestors: applied?.embed_frame_ancestors ?? [],
              adminOrigin: window.location.origin,
            }}
          />
          <EmbedCard name={name} publicUrl={me?.public_url ?? null} ancestors={document.embed_frame_ancestors ?? []} />
          <RemoveCard name={name} onRemove={remove} />
        </Stack>
      </Flex>
    </>
  );
}

/** The page of the project named in the address. */
export function Project() {
  const { name = "" } = useParams();
  const { document, active } = useDraft();
  const project = document?.projects?.[name];

  if (active.isError) {
    return (
      <Box p="8">
        <Problem title={strings.common.loadFailed} detail={active.error.message} />
      </Box>
    );
  }
  if (!document) return null;

  if (!project) {
    return (
      <>
        <Breadcrumb parent={P.breadcrumb} to={paths.projects} current={name} />
        <Stack p="8" gap="4" align="flex-start" maxW="480px">
          <Problem title={P.missing} />
          <Button asChild variant="outline" size="sm">
            <RouterLink to={paths.projects}>{P.back}</RouterLink>
          </Button>
        </Stack>
      </>
    );
  }
  return <ProjectPage name={name} project={project} document={document} applied={active.data?.document} />;
}
