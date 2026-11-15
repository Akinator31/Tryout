// The project form, from the Figma "New project" and "New project — invalid"
// screens: identity, image, placement, capacity, resources and environment,
// beside the checks, the project's YAML and what the agent fixes. Saving puts
// the project in the draft and opens the review.
import { Box, Button, Field, Flex, Grid, IconButton, Input, NativeSelect, RadioCard, Stack, Switch, Text } from "@chakra-ui/react";
import { Check, KeyRound, Plus, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { Breadcrumb } from "../components/Breadcrumb.tsx";
import { Card } from "../components/Card.tsx";
import { CodeBlock } from "../components/CodeBlock.tsx";
import { FormField } from "../components/Fields.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Problem } from "../components/Problem.tsx";
import { Section } from "../components/Section.tsx";
import { TagBadge } from "../components/StateBadge.tsx";
import type { AgentReport, NodeView } from "../model.ts";
import { paths, projectPath } from "../navigation.ts";
import { agentLine } from "../nodes.ts";
import {
  checkProjectForm,
  KIND_DEFAULTS,
  KIND_PORTS,
  live,
  loadBy,
  loadOf,
  newProjectForm,
  overbooking,
  projectForm,
  projectFromForm,
  type FormProblems,
  type ProjectForm,
} from "../projects.ts";
import { useNodes, useSessions } from "../queries.ts";
import { prune, type SettingsDocument } from "../settings/document.ts";
import { stringify } from "../settings/yaml.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

const F = strings.projectForm;

type SetField = <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => void;

interface SectionProps {
  form: ProjectForm;
  set: SetField;
  /** The problems to show: those of the fields edited, or all after a save attempt. */
  shown: FormProblems;
}

/** The kind, as two cards. */
function KindCards({ form, set }: SectionProps) {
  /** Changes the kind, and the port with it while it is the other kind's usual one. */
  const choose = (kind: ProjectForm["kind"]) => {
    const other = kind === "terminal" ? "desktop" : "terminal";
    if (form.port === String(KIND_PORTS[other])) set("port", String(KIND_PORTS[kind]));
    set("kind", kind);
  };

  return (
    <RadioCard.Root value={form.kind} onValueChange={(e) => e.value && choose(e.value as ProjectForm["kind"])} colorPalette="brand" variant="surface">
      <RadioCard.Label textStyle="label-sm">{F.identity.kind}</RadioCard.Label>
      <Grid templateColumns="1fr 1fr" gap="3">
        {(["terminal", "desktop"] as const).map((kind) => (
          <RadioCard.Item key={kind} value={kind} borderColor="border.emphasized">
            <RadioCard.ItemHiddenInput />
            <RadioCard.ItemControl>
              <RadioCard.ItemContent>
                <RadioCard.ItemText textStyle="label-sm">{F.identity.kinds[kind].label}</RadioCard.ItemText>
                <RadioCard.ItemDescription textStyle="text-xs" color="fg.muted">
                  {F.identity.kinds[kind].body}
                </RadioCard.ItemDescription>
              </RadioCard.ItemContent>
              <RadioCard.ItemIndicator />
            </RadioCard.ItemControl>
          </RadioCard.Item>
        ))}
      </Grid>
    </RadioCard.Root>
  );
}

/** Name, title and kind; the name only for a new project. */
function IdentitySection({ form, set, shown, isNew }: SectionProps & { isNew: boolean }) {
  const I = F.identity;

  return (
    <Section title={I.title} description={I.description}>
      <Stack gap="5">
        <Grid templateColumns="1fr 1fr" gap="4" alignItems="start">
          <FormField
            label={I.name}
            required
            mono
            value={form.name}
            onChange={(v) => set("name", v)}
            error={shown.name}
            help={I.nameHelp(form.name)}
            disabled={!isNew}
            placeholder="my-cli"
          />
          <FormField label={I.titleLabel} value={form.title} onChange={(v) => set("title", v)} error={shown.title} help={I.titleHelp(form.name)} />
        </Grid>
        <KindCards form={form} set={set} shown={shown} />
      </Stack>
    </Section>
  );
}

/** A small note in a muted box, with its icon. */
function Note({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <Flex gap="2" px="3" py="2" bg="bg.muted" borderRadius="l2" color="fg.subtle" textStyle="text-xs">
      <Box pt="0.5">{icon}</Box>
      <Text>{children}</Text>
    </Flex>
  );
}

/** Image, port and base path. */
function ImageSection({ form, set, shown }: SectionProps) {
  const I = F.image;

  return (
    <Section title={I.title} description={I.description}>
      <Stack gap="5">
        <FormField
          label={I.image}
          required
          mono
          value={form.image}
          onChange={(v) => set("image", v)}
          error={shown.image}
          help={I.imageHelp}
          placeholder="ghcr.io/me/my-cli@sha256:…"
        />
        <Grid templateColumns="200px 1fr" gap="4" alignItems="start">
          <FormField label={I.port} required mono unit="TCP" value={form.port} onChange={(v) => set("port", v)} error={shown.port} help={I.portHelp} />
          <Field.Root>
            <Field.Label textStyle="label-sm">{I.basePath}</Field.Label>
            <Switch.Root checked={form.stripPrefix} onCheckedChange={(e) => set("stripPrefix", e.checked)} colorPalette="brand" h="10">
              <Switch.HiddenInput />
              <Switch.Control />
              <Switch.Label textStyle="text-sm">{I.strip}</Switch.Label>
            </Switch.Root>
            <Field.HelperText textStyle="text-xs" color="fg.subtle">
              {I.stripHelp}
            </Field.HelperText>
          </Field.Root>
        </Grid>
        <Note icon={<KeyRound size={14} aria-hidden />}>{I.registry}</Note>
      </Stack>
    </Section>
  );
}

/** A labelled native select. */
function SelectField(props: { label: string; value: string; onChange: (v: string) => void; error?: string; help?: string; required?: boolean; children: ReactNode }) {
  const { label, value, onChange, error, help, required, children } = props;

  return (
    <Field.Root invalid={error !== undefined} required={required}>
      <Field.Label textStyle="label-sm">
        {label}
        {required && <Field.RequiredIndicator />}
      </Field.Label>
      <NativeSelect.Root>
        <NativeSelect.Field value={value} onChange={(e) => onChange(e.target.value)} h="10" borderColor="border.emphasized">
          {children}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
      {error ? (
        <Field.ErrorText textStyle="text-xs">{error}</Field.ErrorText>
      ) : (
        help && (
          <Field.HelperText textStyle="text-xs" color="fg.subtle">
            {help}
          </Field.HelperText>
        )
      )}
    </Field.Root>
  );
}

/** The runtimes to offer: the agent's, else runsc, and the project's own when it is another. */
function runtimeOptions(agent: AgentReport | undefined, current: string): string[] {
  const known = agent?.runtimes?.length ? agent.runtimes : ["runsc"];
  return [...new Set([...known, ...(current ? [current] : [])])];
}

/** Node and runtime, with what the node's agent said about itself. */
function PlacementSection({ form, set, shown, document, views }: SectionProps & { document: SettingsDocument; views: NodeView[] }) {
  const P = F.placement;
  const nodes = Object.entries(document.nodes ?? {});
  const view = views.find((v) => v.name === form.node);
  const loads = loadBy(useSessions().data ?? [], "node");
  const profile = view?.agent?.profile;

  return (
    <Section title={P.title} description={P.description}>
      <Grid templateColumns="1fr 1fr" gap="4" alignItems="start">
        <SelectField label={P.node} required value={form.node} onChange={(v) => set("node", v)} error={shown.node} help={view ? (agentLine(view) ?? undefined) : undefined}>
          {!form.node && <option value="">—</option>}
          {nodes.map(([name, n]) => (
            <option key={name} value={name}>
              {`${name} (${P.nodeLoad(live(loadOf(loads, name)), n.max_sessions)})`}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={P.runtime}
          value={form.runtime}
          onChange={(v) => set("runtime", v)}
          error={shown.runtime}
          help={profile && profile !== "dev" ? P.strictHelp(profile) : P.runtimeHelp}
        >
          <option value="">{P.nodeDefault(view?.agent?.default_runtime)}</option>
          {runtimeOptions(view?.agent, form.runtime).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </SelectField>
      </Grid>
    </Section>
  );
}

/** A warning box: the fact in amber, then the detail. */
function Warning({ title, children }: { title: string; children: string }) {
  return (
    <Flex role="status" gap="3" p="4" borderWidth="1px" borderColor="border.emphasized" borderRadius="l2">
      <Box color="fg.warning" pt="0.5">
        <TriangleAlert size={16} aria-hidden />
      </Box>
      <Box>
        <Text textStyle="label-sm" color="fg.warning">
          {title}
        </Text>
        <Text mt="0.5" color="fg.muted">
          {children}
        </Text>
      </Box>
    </Flex>
  );
}

/** Concurrent sessions and maximum age, with a warning when the node is overbooked. */
function CapacitySection({ form, set, shown, overbooked }: SectionProps & { overbooked: { sum: number; cap: number } | null }) {
  const C = F.capacity;

  return (
    <Section title={C.title} description={C.description}>
      <Stack gap="5">
        <Grid templateColumns="1fr 1fr" gap="4" alignItems="start">
          <FormField
            label={C.maxSessions}
            required
            unit={C.unit}
            value={form.maxSessions}
            onChange={(v) => set("maxSessions", v)}
            error={shown.maxSessions}
            help={C.maxSessionsHelp}
          />
          <FormField label={C.maxAge} required mono value={form.maxAge} onChange={(v) => set("maxAge", v)} error={shown.maxAge} help={C.maxAgeHelp} />
        </Grid>
        {overbooked && <Warning title={C.overbooked(form.node, overbooked.sum, overbooked.cap)}>{C.overbookedBody}</Warning>}
      </Stack>
    </Section>
  );
}

/** Memory, CPU and processes; empty fields show the kind's defaults. */
function ResourcesSection({ form, set, shown }: SectionProps) {
  const R = F.resources;
  const defaults = KIND_DEFAULTS[form.kind];
  const custom = form.memory || form.cpus || form.pids;

  /** Empties the three fields, so the kind's defaults apply. */
  const reset = () => {
    set("memory", "");
    set("cpus", "");
    set("pids", "");
  };

  return (
    <Section title={R.title} description={R.description}>
      <Grid templateColumns="repeat(3, 1fr)" gap="4" alignItems="start">
        <FormField label={R.memory} unit="MB" value={form.memory} placeholder={String(defaults.memory_mb)} onChange={(v) => set("memory", v)} error={shown.memory} help={R.memoryHelp} />
        <FormField label={R.cpus} unit="CPU" value={form.cpus} placeholder={String(defaults.cpus)} onChange={(v) => set("cpus", v)} error={shown.cpus} help={R.cpusHelp} />
        <FormField label={R.pids} unit="PIDs" value={form.pids} placeholder={String(defaults.pids)} onChange={(v) => set("pids", v)} error={shown.pids} help={R.pidsHelp} />
      </Grid>
      <Button mt="4" variant="plain" size="xs" px="0" color="fg.warning" disabled={!custom} onClick={reset}>
        <RotateCcw size={14} aria-hidden />
        {R.reset(strings.projects.kinds[form.kind].toLowerCase())}
      </Button>
    </Section>
  );
}

/** The environment variables: a name and a value per row. */
function EnvSection({ form, set, shown }: SectionProps) {
  const E = F.env;

  /** Replaces variable `i` with `change` applied. */
  const update = (i: number, change: Partial<ProjectForm["env"][number]>) => set("env", form.env.map((v, j) => (j === i ? { ...v, ...change } : v)));

  return (
    <Section title={E.title} description={E.description}>
      <Stack gap="3">
        {form.env.length > 0 && (
          <Grid templateColumns="1fr 1.4fr 32px" gap="3" textStyle="label-xs" color="fg.subtle">
            <Text>{E.name}</Text>
            <Text>{E.value}</Text>
          </Grid>
        )}
        {form.env.map((v, i) => (
          <Grid key={i} templateColumns="1fr 1.4fr 32px" gap="3" alignItems="start">
            <Field.Root invalid={shown[`env.${i}.name`] !== undefined}>
              <Input aria-label={E.nameLabel(i)} value={v.name} onChange={(e) => update(i, { name: e.target.value })} fontFamily="mono" h="10" borderColor="border.emphasized" autoComplete="off" spellCheck={false} />
              <Field.ErrorText textStyle="text-xs">{shown[`env.${i}.name`]}</Field.ErrorText>
            </Field.Root>
            <Input aria-label={E.valueLabel(i)} value={v.value} onChange={(e) => update(i, { value: e.target.value })} fontFamily="mono" h="10" borderColor="border.emphasized" autoComplete="off" spellCheck={false} />
            <IconButton aria-label={E.remove(v.name)} title={E.remove(v.name)} variant="ghost" size="sm" mt="1" color="fg.muted" onClick={() => set("env", form.env.filter((_, j) => j !== i))}>
              <Trash2 size={16} />
            </IconButton>
          </Grid>
        ))}
        <Box>
          <Button variant="outline" size="sm" h="9" onClick={() => set("env", [...form.env, { name: "", value: "" }])}>
            <Plus size={16} aria-hidden />
            {E.add}
          </Button>
        </Box>
        <Text textStyle="text-xs" color="fg.subtle">
          {E.reserved}
        </Text>
      </Stack>
    </Section>
  );
}

/** A line of the checks card: done, refused, or a warning. */
function CheckLine({ tone, children }: { tone: "ok" | "error" | "warning"; children: string }) {
  const color = { ok: "fg.success", error: "fg.error", warning: "fg.warning" }[tone];
  const icon = { ok: <Check size={14} aria-hidden />, error: <X size={14} aria-hidden />, warning: <TriangleAlert size={14} aria-hidden /> }[tone];

  return (
    <Flex gap="2" align="flex-start" color={tone === "ok" ? "fg" : color}>
      <Box color={color} pt="0.5">
        {icon}
      </Box>
      <Text>{children}</Text>
    </Flex>
  );
}

/** What the browser checked: the fields, the node's last health check, and the node's cap. */
function ChecksCard({ problems, node, view, overbooked }: { problems: number; node: string; view: NodeView | undefined; overbooked: boolean }) {
  const C = F.checks;

  return (
    <Card p="5">
      <Text textStyle="label-sm" mb="3">
        {C.title}
      </Text>
      <Stack gap="2" role="status">
        {problems === 0 ? <CheckLine tone="ok">{C.valid}</CheckLine> : <CheckLine tone="error">{C.problems(problems)}</CheckLine>}
        {node && view?.up === true && <CheckLine tone="ok">{C.nodeUp(node)}</CheckLine>}
        {node && view?.up === false && view.checked_at !== null && <CheckLine tone="warning">{C.nodeDown(node)}</CheckLine>}
        {node && (!view || view.checked_at === null) && <CheckLine tone="warning">{C.nodeUnknown(node)}</CheckLine>}
        {overbooked && <CheckLine tone="warning">{C.overbooked(node)}</CheckLine>}
      </Stack>
      <Text mt="3" textStyle="text-xs" color="fg.subtle">
        {C.review}
      </Text>
    </Card>
  );
}

/** What the agent enforces on every session, whatever the project says. */
function AgentCard() {
  const A = F.agent;

  return (
    <Card p="5">
      <Text textStyle="label-sm">{A.title}</Text>
      <Text mt="1" mb="3" textStyle="text-xs" color="fg.subtle">
        {A.body}
      </Text>
      <Flex gap="2" wrap="wrap">
        {A.chips.map((c) => (
          <TagBadge key={c}>{c}</TagBadge>
        ))}
      </Flex>
    </Card>
  );
}

/** The labels of the problems, for the banner at the top after a save attempt. */
function problemList(problems: FormProblems): string[] {
  const labels: Record<string, string> = {
    name: F.identity.name,
    title: F.identity.titleLabel,
    image: F.image.image,
    port: F.image.port,
    node: F.placement.node,
    runtime: F.placement.runtime,
    maxSessions: F.capacity.maxSessions,
    maxAge: F.capacity.maxAge,
    memory: F.resources.memory,
    cpus: F.resources.cpus,
    pids: F.resources.pids,
  };
  return Object.entries(problems).map(([key, text]) => `${labels[key] ?? F.env.title}: ${text}`);
}

interface EditorProps {
  /** The project's name when editing; null for a new one. */
  name: string | null;
  document: SettingsDocument;
}

/** The form itself, once the settings are loaded. */
function Editor({ name, document }: EditorProps) {
  const navigate = useNavigate();
  const { edit, openReview } = useDraft();
  const views = useNodes().data ?? [];
  const previous = name ? document.projects?.[name] : undefined;
  const [form, setForm] = useState<ProjectForm>(() => (name && previous ? projectForm(name, previous) : newProjectForm(Object.keys(document.nodes ?? {})[0])));
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);

  const isNew = name === null;
  const problems = checkProjectForm(form, { taken: Object.keys(document.projects ?? {}), nodes: Object.keys(document.nodes ?? {}), isNew });
  const count = Object.keys(problems).length;
  const shown = attempted ? problems : Object.fromEntries(Object.entries(problems).filter(([k]) => touched.has(k.split(".")[0])));

  const project = prune(projectFromForm(form, previous));
  const withProject: SettingsDocument = { ...document, projects: { ...document.projects, [form.name]: project } };
  const overbooked = problems.maxSessions ? null : overbooking(withProject, form.node);

  /** Changes one field and marks it edited. */
  const set: SetField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setTouched((t) => new Set(t).add(key));
  };

  /** Puts the project in the draft and opens the review on its page; with problems, shows them all instead. */
  const save = () => {
    if (count > 0) return setAttempted(true);

    edit((d) => {
      d.projects ??= {};
      d.projects[form.name] = projectFromForm(form, previous);
    });
    navigate(projectPath(form.name));
    openReview();
  };

  const cancelTo = name ? projectPath(name) : paths.projects;
  const actions = (
    <Flex gap="2">
      <Button asChild variant="ghost" size="sm" h="10">
        <RouterLink to={cancelTo}>{F.cancel}</RouterLink>
      </Button>
      <Button colorPalette="brand" size="sm" h="10" onClick={save} disabled={attempted && count > 0}>
        <Check size={16} aria-hidden />
        {isNew ? F.create : F.save}
      </Button>
    </Flex>
  );

  return (
    <>
      <Breadcrumb parent={strings.project.breadcrumb} to={paths.projects} current={isNew ? F.newTitle : name} />
      <PageHeader title={isNew ? F.newTitle : F.editTitle(name)} description={isNew ? F.newDescription : F.editDescription} action={actions} />

      <Flex px="8" gap="6" align="flex-start">
        <Stack flex="1" minW="0" maxW="760px" gap="6">
          {attempted && count > 0 && <Problem title={F.problems.title(count)} detail={problemList(problems).join(" ")} />}
          <IdentitySection form={form} set={set} shown={shown} isNew={isNew} />
          <ImageSection form={form} set={set} shown={shown} />
          <PlacementSection form={form} set={set} shown={shown} document={document} views={views} />
          <CapacitySection form={form} set={set} shown={shown} overbooked={overbooked} />
          <ResourcesSection form={form} set={set} shown={shown} />
          <EnvSection form={form} set={set} shown={shown} />
        </Stack>
        <Stack w="380px" flexShrink="0" gap="4" position="sticky" top="6">
          <ChecksCard problems={count} node={form.node} view={views.find((v) => v.name === form.node)} overbooked={overbooked !== null} />
          <CodeBlock label={F.yaml(form.name)} text={stringify({ projects: { [form.name || "<name>"]: project } })} />
          <AgentCard />
        </Stack>
      </Flex>
    </>
  );
}

/** The new-project page, or a project's edit page under `/projects/:name/edit`. */
export function ProjectEditor() {
  const { name = null } = useParams();
  const { document, active } = useDraft();

  if (active.isError) {
    return (
      <Box p="8">
        <Problem title={strings.common.loadFailed} detail={active.error.message} />
      </Box>
    );
  }
  if (!document) return null;

  if (name !== null && !document.projects?.[name]) {
    return (
      <Box p="8">
        <Problem title={strings.project.missing} />
      </Box>
    );
  }
  return <Editor key={name ?? ""} name={name} document={document} />;
}
