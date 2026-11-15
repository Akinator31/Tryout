// The embedding page, from the Figma "Embedding" screen: the origins allowed
// to frame the embed page, the per-IP visitor limits, and the trusted
// proxies, which only tryout.yaml sets.
import { Badge, Box, Button, Field, Flex, Grid, IconButton, Input, Stack, Text } from "@chakra-ui/react";
import { Globe, Info, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PageHeader } from "../components/PageHeader.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { Aside, Section } from "../components/Section.tsx";
import { DraftField } from "../components/Fields.tsx";
import { parseDuration, parseWhole } from "../settings/parse.ts";
import { DEFAULT_LIMITS, type Limits, type SettingsDocument } from "../settings/document.ts";
import { checkOrigin, isWildcard, type OriginCheck } from "../settings/origin.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

const E = strings.embedding;

/** One allowed origin, with its badge and remove button; 'self' has neither button. */
function OriginRow({ origin, badge, onRemove }: { origin: string; badge?: string; onRemove?: () => void }) {
  return (
    <Flex as="li" h="9" ps="3" pe="1" gap="3" align="center" bg="bg.muted" borderWidth="1px" borderColor="border" borderRadius="l2">
      <Box color="fg.muted">
        <Globe size={16} aria-hidden />
      </Box>
      <Text flex="1" textStyle="mono-sm" truncate>
        {origin}
      </Text>
      {badge && (
        <Badge size="sm" variant="subtle" colorPalette="gray" bg="bg.emphasized" color="fg.muted" borderRadius="l1" textStyle="label-xs">
          {badge}
        </Badge>
      )}
      {onRemove && (
        <IconButton aria-label={E.origins.remove(origin)} title={E.origins.remove(origin)} variant="ghost" size="xs" color="fg.muted" onClick={onRemove}>
          <Trash2 size={16} />
        </IconButton>
      )}
    </Flex>
  );
}

/** The message for an origin that cannot be added. */
function originProblem(check: Exclude<OriginCheck, { ok: true }>): string {
  const P = E.origins.problems;
  if (check.problem === "scheme") return P.scheme(check.fix!);
  if (check.problem === "path") return P.path(check.fix!);
  return P[check.problem];
}

/** The allowed origins: the list and the form that adds one. */
function OriginsCard({ origins, edit }: { origins: string[]; edit: (update: (d: SettingsDocument) => void) => void }) {
  const [input, setInput] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  /** Adds the typed origin, or says why it cannot be added. */
  function add(e: FormEvent) {
    e.preventDefault();

    const check = checkOrigin(input, origins);
    if (!check.ok) return setProblem(originProblem(check));

    edit((d) => (d.embed_frame_ancestors = [...(d.embed_frame_ancestors ?? []), check.origin]));
    setInput("");
    setProblem(null);
  }

  /** Removes one origin from the list. */
  const remove = (origin: string) => edit((d) => (d.embed_frame_ancestors = (d.embed_frame_ancestors ?? []).filter((o) => o !== origin)));

  return (
    <Section title={E.origins.title} description={E.origins.description}>
      <Stack as="ul" gap="2" listStyleType="none">
        <OriginRow origin="'self'" badge={E.origins.always} />
        {origins.map((o) => (
          <OriginRow key={o} origin={o} badge={isWildcard(o) ? E.origins.wildcard : undefined} onRemove={() => remove(o)} />
        ))}
      </Stack>

      <form onSubmit={add} noValidate>
        <Field.Root invalid={problem !== null} mt="4">
          <Flex gap="2" w="full">
            <Input
              aria-label={E.origins.input}
              placeholder={E.origins.placeholder}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setProblem(null);
              }}
              fontFamily="mono"
              h="10"
              flex="1"
              borderColor="border.emphasized"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="outline" size="sm" h="10">
              <Plus size={16} aria-hidden />
              {E.origins.add}
            </Button>
          </Flex>
          {problem && <Field.ErrorText textStyle="text-xs">{problem}</Field.ErrorText>}
        </Field.Root>
      </form>
    </Section>
  );
}

/** The per-IP limits, with their defaults when the settings leave them out. */
function LimitsCard({ limits, edit }: { limits: Limits; edit: (update: (d: SettingsDocument) => void) => void }) {
  const L = E.limits;
  const newTickets = limits.new_tickets_per_ip ?? DEFAULT_LIMITS.new_tickets_per_ip;

  /** Writes one limit to the draft. */
  const set = (update: (l: Limits) => void) =>
    edit((d) => {
      d.limits ??= {};
      update(d.limits);
    });

  return (
    <Section title={L.title} description={L.description}>
      <Grid templateColumns="repeat(4, 1fr)" gap="4" alignItems="start">
        <DraftField
          label={L.live}
          unit={L.liveUnit}
          value={limits.live_tickets_per_ip ?? DEFAULT_LIMITS.live_tickets_per_ip}
          format={String}
          parse={parseWhole}
          invalid={L.whole}
          onCommit={(v) => set((l) => (l.live_tickets_per_ip = v))}
        />
        <DraftField
          label={L.newTickets}
          unit={L.newUnit}
          value={newTickets.max}
          format={String}
          parse={parseWhole}
          invalid={L.whole}
          onCommit={(v) => set((l) => (l.new_tickets_per_ip = { ...newTickets, max: v }))}
        />
        <DraftField
          label={L.window}
          help={L.windowHelp}
          mono
          value={newTickets.per}
          format={String}
          parse={parseDuration}
          invalid={L.duration}
          onCommit={(v) => set((l) => (l.new_tickets_per_ip = { ...newTickets, per: v }))}
        />
        <DraftField
          label={L.streams}
          unit={L.streamsUnit}
          help={L.streamsHelp}
          value={limits.streams_per_ip ?? DEFAULT_LIMITS.streams_per_ip}
          format={String}
          parse={parseWhole}
          invalid={L.whole}
          onCommit={(v) => set((l) => (l.streams_per_ip = v))}
        />
      </Grid>
    </Section>
  );
}

/** The embedding page. */
export function Embedding() {
  const { document, active, edit } = useDraft();

  return (
    <>
      <PageHeader title={E.title} description={E.description} action={<PendingActions />} />

      {active.isError && (
        <Box px="8">
          <Problem title={strings.common.loadFailed} detail={active.error.message} />
        </Box>
      )}
      {document && (
        <Flex px="8" gap="6" align="flex-start">
          <Stack flex="1" minW="0" maxW="760px" gap="6">
            <OriginsCard origins={document.embed_frame_ancestors ?? []} edit={edit} />
            <LimitsCard limits={document.limits ?? {}} edit={edit} />
            <Section title={E.proxies.title} description={E.proxies.description}>
              <Text textStyle="text-xs" color="fg.subtle">
                {E.proxies.readOnly}
              </Text>
            </Section>
          </Stack>
          <Stack w="380px" flexShrink="0" gap="4">
            <Aside icon={<Info size={16} aria-hidden />} title={E.gateway.title}>
              {E.gateway.body}
            </Aside>
            <Aside icon={<TriangleAlert size={16} aria-hidden />} title={E.shared.title} tone="warning">
              {E.shared.body}
            </Aside>
          </Stack>
        </Flex>
      )}
    </>
  );
}
