// The projects page, from the Figma "Projects" and "Projects — empty" screens:
// every project with its kind, node, load, queue and state, or the first steps
// when there is none.
import { Box, Button, Flex, Grid, Link, Stack, Table, Text } from "@chakra-ui/react";
import { Box as BoxIcon, Check, ExternalLink, Monitor, Plus, SquareTerminal } from "lucide-react";
import { Link as RouterLink, useNavigate } from "react-router";
import { Card } from "../components/Card.tsx";
import { DataCell, DataHeader, DataTable } from "../components/DataTable.tsx";
import { LoadBar } from "../components/LoadBar.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { ProjectBadge } from "../components/StateBadge.tsx";
import { slots } from "../format.ts";
import { paths, projectPath } from "../navigation.ts";
import { byName, live, loadBy, loadOf, nodesUp, projectState, projectsSummary, type Load } from "../projects.ts";
import { useNodes, useSessions } from "../queries.ts";
import type { ProjectSettings, SettingsDocument } from "../settings/document.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

const P = strings.projects;
const GUIDE_URL = "https://akinator31.github.io/Tryout/packaging/";

/** A project's kind, with its icon. */
export function KindLabel({ kind }: { kind: ProjectSettings["kind"] }) {
  const Icon = kind === "desktop" ? Monitor : SquareTerminal;

  return (
    <Flex gap="2" align="center">
      <Icon size={16} aria-hidden />
      {P.kinds[kind]}
    </Flex>
  );
}

/** The "New project" button. */
function NewProjectButton() {
  return (
    <Button asChild colorPalette="brand" size="sm" h="10">
      <RouterLink to={paths.newProject}>
        <Plus size={16} aria-hidden />
        {P.add}
      </RouterLink>
    </Button>
  );
}

interface RowProps {
  name: string;
  /** The project as the page shows it, pending changes included. */
  project: ProjectSettings;
  /** The project in the active revision, which visitors get now; undefined when not applied yet. */
  running: ProjectSettings | undefined;
  load: Load;
  up: Map<string, boolean>;
}

/** One project's row; clicking it opens the project. Its state is the active revision's. */
function Row({ name, project, running, load, up }: RowProps) {
  const navigate = useNavigate();
  const state = projectState({ project: running ?? project, applied: running !== undefined, nodeUp: up.get((running ?? project).node), load });

  return (
    <Table.Row bg="transparent" cursor="pointer" _hover={{ bg: "bg.muted" }} onClick={() => navigate(projectPath(name))}>
      <DataCell maxW="280px">
        <Link asChild color="fg" textStyle="label-sm" aria-label={P.open(name)} onClick={(e) => e.stopPropagation()}>
          <RouterLink to={projectPath(name)}>{name}</RouterLink>
        </Link>
        <Text textStyle="mono-xs" color="fg.subtle" truncate>
          {project.image}
        </Text>
      </DataCell>
      <DataCell muted>
        <KindLabel kind={project.kind} />
      </DataCell>
      <DataCell muted>{project.node}</DataCell>
      <DataCell>
        <Text textStyle="mono-sm">{`${live(load)} / ${project.max_sessions}`}</Text>
        <LoadBar used={live(load)} max={project.max_sessions} />
      </DataCell>
      <DataCell textStyle="mono-sm" color={load.waiting > 0 ? "fg.warning" : "fg.muted"}>
        {load.waiting}
      </DataCell>
      <DataCell textStyle="mono-sm" muted>
        {project.max_age}
      </DataCell>
      <DataCell>
        <ProjectBadge state={state} />
      </DataCell>
    </Table.Row>
  );
}

/** The table of projects, under the summary line. */
function ProjectsTable({ document, applied }: { document: SettingsDocument; applied: SettingsDocument | undefined }) {
  const sessions = useSessions().data ?? [];
  const up = nodesUp(useNodes().data);
  const loads = loadBy(sessions);
  const projects = Object.entries(document.projects ?? {}).sort(byName);

  return (
    <>
      <Text color="fg.muted" mb="6">
        {projectsSummary(applied ?? document, loads, up, slots(applied ?? document))}
      </Text>
      <Card>
        <DataTable label={P.title}>
          <Table.Header>
            <Table.Row bg="transparent">
              {Object.values(P.columns).map((c) => (
                <DataHeader key={c}>{c}</DataHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {projects.map(([name, project]) => (
              <Row
                key={name}
                name={name}
                project={project}
                running={applied?.projects?.[name]}
                load={loadOf(loads, name)}
                up={up}
              />
            ))}
          </Table.Body>
        </DataTable>
      </Card>
    </>
  );
}

/** One of the first steps: a check when done, else its number. */
function Step({ n, done, title, body, to }: { n: number; done: boolean; title: string; body: string; to?: string }) {
  const mark = done ? (
    <Flex w="6" h="6" borderRadius="full" bg="green.subtle" color="fg.success" align="center" justify="center">
      <Check size={14} aria-hidden />
    </Flex>
  ) : (
    <Flex w="6" h="6" borderRadius="full" bg="bg.emphasized" color="fg.muted" align="center" justify="center" textStyle="label-xs">
      {n}
    </Flex>
  );

  return (
    <Card p="5">
      <Flex gap="3" align="center">
        {mark}
        {to ? (
          <Link asChild color={done ? "fg.muted" : "fg"} textStyle="label-sm">
            <RouterLink to={to}>{title}</RouterLink>
          </Link>
        ) : (
          <Text textStyle="label-sm">{title}</Text>
        )}
      </Flex>
      <Text mt="3" textStyle="text-xs" color="fg.subtle">
        {body}
      </Text>
    </Card>
  );
}

/** What to do when there is no project yet, with the steps already done checked. */
function EmptyProjects({ document }: { document: SettingsDocument }) {
  const E = P.empty;
  const done = [Object.keys(document.nodes ?? {}).length > 0, (document.embed_frame_ancestors ?? []).length > 0, false];
  const links = [paths.nodes, paths.embedding, paths.newProject];

  return (
    <Box px="8">
      <Stack align="center" textAlign="center" gap="4" py="16" maxW="460px" mx="auto">
        <Box color="brand.solid">
          <BoxIcon size={24} aria-hidden />
        </Box>
        <Text as="h2" textStyle="heading-lg">
          {E.title}
        </Text>
        <Text color="fg.muted">{E.body}</Text>
        <Flex gap="4" align="center">
          <NewProjectButton />
          <Link href={GUIDE_URL} target="_blank" rel="noreferrer" textStyle="label-sm" color="fg">
            <ExternalLink size={16} aria-hidden />
            {E.guide}
          </Link>
        </Flex>
      </Stack>
      <Grid templateColumns="repeat(3, 1fr)" gap="4" mt="6">
        {E.steps.map((step, i) => (
          <Step key={step.title} n={i + 1} done={done[i]} title={step.title} body={step.body} to={links[i]} />
        ))}
      </Grid>
    </Box>
  );
}

/** The projects page. */
export function Projects() {
  const { document, active } = useDraft();
  const empty = document && Object.keys(document.projects ?? {}).length === 0;

  return (
    <>
      <PageHeader
        title={P.title}
        description={P.description}
        action={
          <Flex gap="2">
            <PendingActions />
            <NewProjectButton />
          </Flex>
        }
      />

      {active.isError && (
        <Box px="8">
          <Problem title={strings.common.loadFailed} detail={active.error.message} />
        </Box>
      )}
      {document && empty && <EmptyProjects document={document} />}
      {document && !empty && (
        <Box px="8">
          <ProjectsTable document={document} applied={active.data?.document} />
        </Box>
      )}
    </>
  );
}
