// The nodes page, from the Figma "Nodes — add node" screen: each node with its
// last health check, and a drawer that adds or edits one. Test connection runs
// the dry run with the node in the settings; saving puts it in the draft and
// opens the review.
import { Box, Button, CloseButton, Drawer, Flex, IconButton, Portal, Stack, Text } from "@chakra-ui/react";
import { Check, Pencil, Play, Plus, Server, ServerOff, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useNow } from "../clock.ts";
import { Card } from "../components/Card.tsx";
import { FormField } from "../components/Fields.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { NodeBadge } from "../components/StateBadge.tsx";
import { settingsRefusal } from "../settings/refusals.ts";
import type { NodeView } from "../model.ts";
import {
  agentLine,
  checkNodeForm,
  connectionResult,
  downLine,
  newNodeForm,
  nodeForm,
  nodeFromForm,
  nodeState,
  nodeUsers,
  type ConnectionResult,
  type NodeForm,
} from "../nodes.ts";
import { useNodes, useValidate } from "../queries.ts";
import { byName, live } from "../projects.ts";
import { deepEqual, prune, type NodeSettings, type SettingsDocument } from "../settings/document.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";
import { useForm } from "../useForm.ts";

const N = strings.nodes;

/** A line under a node's header: an icon and a text in the tone given. */
function DetailLine({ tone = "muted", children }: { tone?: "muted" | "warning" | "error"; children: string }) {
  const color = { muted: "fg.muted", warning: "fg.warning", error: "fg.error" }[tone];

  return (
    <Flex px="5" py="2.5" gap="2" align="flex-start" borderTopWidth="1px" borderColor="border" color={color} textStyle="text-xs">
      {tone !== "muted" && (
        <Box pt="0.5">
          <TriangleAlert size={14} aria-hidden />
        </Box>
      )}
      <Text>{children}</Text>
    </Flex>
  );
}

interface NodeCardProps {
  name: string;
  node: NodeSettings;
  view: NodeView | undefined;
  users: string[];
  onEdit: () => void;
  onRemove: () => void;
}

/** The lines under a node's header: what the agent said or why it is down, its projects, and the dev profile's warning. */
function NodeDetails({ node, view, users }: Pick<NodeCardProps, "node" | "view" | "users">) {
  const now = useNow(5000);
  const state = nodeState(view);
  const D = N.details;

  const first = {
    draft: D.draft,
    unchecked: D.unchecked,
    healthy: view && [agentLine(view), D.load(live(view.tickets), node.max_sessions)].filter(Boolean).join(" "),
    unreachable: view && downLine(view, users, now),
  }[state];

  return (
    <>
      {first && <DetailLine tone={state === "unreachable" ? "error" : "muted"}>{first}</DetailLine>}
      {state !== "unreachable" && <DetailLine>{D.users(users)}</DetailLine>}
      {state === "healthy" && view?.agent?.profile === "dev" && <DetailLine tone="warning">{D.dev}</DetailLine>}
    </>
  );
}

/** One node: its name, state and addresses, its details, and Edit and Remove. */
function NodeCard({ name, node, view, users, onEdit, onRemove }: NodeCardProps) {
  const state = nodeState(view);
  const Icon = state === "unreachable" ? ServerOff : Server;
  const blocked = users.length > 0;

  return (
    <Card as="section" aria-label={name} borderColor={state === "unreachable" ? "border.error" : "border"}>
      <Flex px="5" py="4" gap="4" align="center">
        <Box color={state === "unreachable" ? "fg.error" : "fg.muted"}>
          <Icon size={20} aria-hidden />
        </Box>
        <Box flex="1" minW="0">
          <Flex gap="3" align="center">
            <Text as="h2" textStyle="heading-md">
              {name}
            </Text>
            <NodeBadge state={state} />
          </Flex>
          <Text mt="1" textStyle="mono-xs" color="fg.subtle" truncate>
            {`${node.agent_url} → ${node.public_url}`}
          </Text>
        </Box>
        <Button variant="outline" size="sm" h="8" aria-label={N.editLabel(name)} onClick={onEdit}>
          <Pencil size={14} aria-hidden />
          {N.edit}
        </Button>
        <IconButton
          aria-label={N.removeLabel(name)}
          title={blocked ? N.inUse(users) : N.removeLabel(name)}
          variant="ghost"
          size="sm"
          color="fg.muted"
          disabled={blocked}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </IconButton>
      </Flex>
      <NodeDetails node={node} view={view} users={users} />
    </Card>
  );
}

/** What Test connection found, in a bordered box. */
function ConnectionBox({ result }: { result: ConnectionResult }) {
  const F = N.form;
  if ("refused" in result) return <Problem title={F.refused} detail={result.refused.join(" ")} />;
  if (!result.ok) return <Problem title={F.notConnected} detail={result.reason} />;

  return (
    <Flex role="status" gap="3" p="4" borderWidth="1px" borderColor="border.emphasized" borderRadius="l2" color="fg.success">
      <Check size={16} aria-hidden />
      <Text textStyle="label-sm">{F.connected}</Text>
    </Flex>
  );
}

/** Runs the dry run of `document` with the node, as a connection test. */
function useConnectionTest() {
  const validate = useValidate();
  const [result, setResult] = useState<ConnectionResult | null>(null);

  /** Tests the agent of `name` by checking `document`. */
  const run = (name: string, document: SettingsDocument) => {
    setResult(null);
    validate.mutate(document, {
      onSuccess: (v) => setResult(connectionResult(name, v)),
      onError: (e) => {
        const refusal = settingsRefusal(e);
        setResult(refusal?.kind === "invalid" ? { refused: refusal.problems } : null);
      },
    });
  };

  const failed = validate.isError && result === null;
  return { run, result, pending: validate.isPending, failed, reset: () => setResult(null) };
}

interface DrawerProps {
  /** The node's name when editing; null to add one. */
  name: string | null;
  document: SettingsDocument;
  onClose: () => void;
}

interface NodeFieldsProps {
  form: NodeForm;
  set: (key: keyof NodeForm, value: string) => void;
  shown: Partial<Record<string, string>>;
  isNew: boolean;
}

/** The fields of the node form; the name only for a new node. */
function NodeFields({ form, set, shown, isNew }: NodeFieldsProps) {
  const F = N.form;

  /** The props of the mono text field over `key`. */
  const field = (key: keyof NodeForm) => ({ value: form[key], onChange: (v: string) => set(key, v), error: shown[key], mono: true });

  return (
    <Stack gap="5">
      {isNew && <FormField label={F.name} required help={F.nameHelp} placeholder={F.placeholders.name} {...field("name")} />}
      <FormField label={F.agentUrl} required help={F.agentUrlHelp} placeholder={F.placeholders.agentUrl} {...field("agentUrl")} />
      <FormField label={F.serverName} help={F.serverNameHelp} placeholder={F.placeholders.serverName} {...field("serverName")} />
      <FormField label={F.publicUrl} required help={F.publicUrlHelp} placeholder={F.placeholders.publicUrl} {...field("publicUrl")} />
      <FormField label={F.probeUrl} help={F.probeUrlHelp} {...field("probeUrl")} />
      <Box maxW="200px">
        <FormField label={F.maxSessions} required unit={F.unit} {...field("maxSessions")} mono={false} />
      </Box>
      <Text mt="-3" textStyle="text-xs" color="fg.subtle">
        {F.maxSessionsHelp}
      </Text>
    </Stack>
  );
}

/** The drawer's content: the form, the test's outcome, and its buttons. */
function NodeEditor({ name, document, onClose }: DrawerProps) {
  const F = N.form;
  const { edit, openReview } = useDraft();
  const test = useConnectionTest();
  const existing = name ? document.nodes?.[name] : undefined;

  const isNew = name === null;
  const context = { taken: Object.keys(document.nodes ?? {}), isNew };
  const form = useForm(() => (name && existing ? nodeForm(name, existing) : newNodeForm()), (f) => checkNodeForm(f, context));

  /** Changes one field and forgets the last test. */
  const set = (key: keyof NodeForm, value: string) => {
    form.set(key, value);
    test.reset();
  };

  /** Tests the connection with the node in the settings, or shows the problems first. */
  const runTest = () => {
    if (!form.attempt()) return;

    const node = nodeFromForm(form.values);
    test.run(form.values.name, { ...document, nodes: { ...document.nodes, [form.values.name]: node } });
  };

  /** Puts the node in the draft and opens the review; with problems, shows them all; without a change, only closes. */
  const save = () => {
    if (!form.attempt()) return;

    const node = nodeFromForm(form.values);
    onClose();
    if (existing && deepEqual(prune(existing), prune(node))) return;

    edit((d) => {
      d.nodes ??= {};
      d.nodes[form.values.name] = node;
    });
    openReview();
  };

  return (
    <>
      <Drawer.Header px="6" pt="6" pb="5" borderBottomWidth="1px" borderColor="border" display="block">
        <Drawer.Title textStyle="heading-lg">{isNew ? F.addTitle : F.editTitle(name)}</Drawer.Title>
        <Text mt="1" color="fg.muted">
          {F.description}
        </Text>
        <Drawer.CloseTrigger asChild top="5" insetEnd="5">
          <CloseButton size="sm" aria-label={strings.common.close} />
        </Drawer.CloseTrigger>
      </Drawer.Header>
      <Drawer.Body px="6" py="5">
        <Stack gap="5">
          <NodeFields form={form.values} set={set} shown={form.shown} isNew={isNew} />
          {test.result && <ConnectionBox result={test.result} />}
          {test.failed && <Problem title={F.testFailed} />}
        </Stack>
      </Drawer.Body>
      <Drawer.Footer px="6" py="4" gap="2" borderTopWidth="1px" borderColor="border">
        <Button variant="outline" size="sm" h="10" me="auto" loading={test.pending} loadingText={F.testing} onClick={runTest}>
          <Play size={16} aria-hidden />
          {F.test}
        </Button>
        <Button variant="ghost" size="sm" h="10" onClick={onClose}>
          {F.cancel}
        </Button>
        <Button colorPalette="brand" size="sm" h="10" onClick={save} disabled={form.attempted && form.count > 0}>
          <Check size={16} aria-hidden />
          {isNew ? N.add : F.save}
        </Button>
      </Drawer.Footer>
    </>
  );
}

/**
 * The drawer on the right that adds or edits a node. Each opening has its own
 * `opening` number, so a drawer opened again while the last one was still
 * closing starts from a fresh form.
 */
function NodeDrawer({ open, opening, ...props }: DrawerProps & { open: boolean; opening: number }) {
  return (
    <Drawer.Root open={open} onOpenChange={(e) => !e.open && props.onClose()} placement="end" size="md" lazyMount unmountOnExit>
      <Portal>
        <Drawer.Backdrop bg="blackAlpha.700" />
        <Drawer.Positioner>
          <Drawer.Content bg="bg.subtle" borderStartWidth="1px" borderColor="border.emphasized" shadow="none">
            <NodeEditor key={opening} {...props} />
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

/** The nodes page. */
export function Nodes() {
  const { document, active, edit, openReview } = useDraft();
  const views = useNodes().data ?? [];
  const [editing, setEditing] = useState<{ name: string | null; opening: number } | null>(null);
  const [openings, setOpenings] = useState(0);

  /** Opens the drawer on `name`, or on a new node with null. */
  const open = (name: string | null) => {
    setOpenings((n) => n + 1);
    setEditing({ name, opening: openings + 1 });
  };
  const nodes = Object.entries(document?.nodes ?? {}).sort(byName);

  /** Removes a node from the draft and opens the review. */
  const remove = (name: string) => {
    edit((d) => {
      delete d.nodes?.[name];
    });
    openReview();
  };

  const addButton = (
    <Button colorPalette="brand" size="sm" h="10" onClick={() => open(null)}>
      <Plus size={16} aria-hidden />
      {N.add}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={N.title}
        description={N.description}
        action={
          <Flex gap="2">
            <PendingActions />
            {addButton}
          </Flex>
        }
      />

      <Stack px="8" gap="4" maxW="1100px">
        {active.isError && <Problem title={strings.common.loadFailed} detail={active.error.message} />}
        {document && nodes.length === 0 && <Text color="fg.muted">{N.empty}</Text>}
        {document &&
          nodes.map(([name, node]) => (
            <NodeCard
              key={name}
              name={name}
              node={node}
              view={views.find((v) => v.name === name)}
              users={nodeUsers(document, name)}
              onEdit={() => open(name)}
              onRemove={() => remove(name)}
            />
          ))}
      </Stack>

      {document && <NodeDrawer open={editing !== null} opening={editing?.opening ?? openings} name={editing?.name ?? null} document={document} onClose={() => setEditing(null)} />}
    </>
  );
}
