// The "Review and apply" dialog, from the Figma screen of that name: the
// draft's changes as chips and a YAML diff, the server's dry run, a note, and
// Apply, which publishes the draft as the next revision.
import { Box, Button, Dialog, Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { usePublish, useValidate } from "../queries.ts";
import { downloadLogo, downloadSettings } from "../settings/download.ts";
import { settingsRefusal, type SettingsRefusal } from "../settings/refusals.ts";
import { noteFrom } from "../settings/labels.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";
import { ChangeChips } from "./ChangeChips.tsx";
import { DialogFrame, DialogShell } from "./ConfirmDialog.tsx";
import { DiffView } from "./DiffView.tsx";
import { DownloadButton } from "./DownloadButton.tsx";
import { Problem } from "./Problem.tsx";

const R = strings.review;
const MAX_NOTE = 200;

/** A refusal in words: what to tell the operator, and the details. */
function refusalText(refusal: SettingsRefusal | null): { title: string; detail?: string } {
  if (refusal?.kind === "invalid") return { title: R.invalid, detail: refusal.problems.join(" ") };
  if (refusal?.kind === "moved") return { title: R.moved };
  if (refusal?.kind === "nodeInUse") return { title: R.nodeInUse(refusal.nodes) };
  return { title: strings.common.actionFailed };
}

/** A line of the dry run's outcome: a check, or an amber warning. */
function CheckLine({ ok, children }: { ok: boolean; children: string }) {
  return (
    <Flex gap="2" align="flex-start" color={ok ? "fg" : "fg.warning"}>
      <Box color={ok ? "fg.success" : "fg.warning"} pt="0.5">
        {ok ? <Check size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
      </Box>
      <Text>{children}</Text>
    </Flex>
  );
}

/** What the dry run said: checking, refused with problems, or valid with warnings. */
function Checks({ validate }: { validate: ReturnType<typeof useValidate> }) {
  if (validate.isPending || validate.isIdle) return <Text color="fg.muted">{R.checking}</Text>;

  if (validate.isError) {
    const refusal = settingsRefusal(validate.error);
    return refusal ? <Problem {...refusalText(refusal)} /> : <Problem title={R.checkFailed} detail={validate.error.message} />;
  }

  return (
    <Stack gap="1.5" role="status">
      <CheckLine ok>{R.valid}</CheckLine>
      {validate.data.warnings.map((w) => (
        <CheckLine key={w} ok={false}>
          {w}
        </CheckLine>
      ))}
    </Stack>
  );
}

/** The review dialog; it opens from any page's Review button or action. */
export function ReviewDialog() {
  const { draft, changes, reviewing, closeReview, discard } = useDraft();
  const validate = useValidate();
  const publish = usePublish();
  const [note, setNote] = useState("");

  // While open, the draft is checked and the note filled from its changes: on opening, and
  // again when the draft moves on top of a newer revision.
  const pending = reviewing ? draft?.document : undefined;
  useEffect(() => {
    if (!pending) return;
    validate.mutate(pending);
    setNote(noteFrom(changes, MAX_NOTE));
  }, [pending]);

  /** Closes the dialog and forgets the last attempt; the draft stays. */
  const close = () => {
    publish.reset();
    closeReview();
  };

  /** Publishes the draft; after a 409 for a newer revision, the draft moves onto it and is checked again. */
  const apply = () => {
    if (!draft) return;

    const publication = { base: draft.base, document: draft.document, note: note.trim() || undefined };
    publish.mutate(publication, {
      onSuccess: () => {
        discard();
        close();
      },
    });
  };

  const next = (draft?.base ?? 0) + 1;
  const logo = draft?.document.theme?.logo?.asset;
  const blocked = !draft || validate.isIdle || validate.isPending || validate.isError || publish.isPending;

  return (
    <DialogShell open={reviewing} onClose={close} maxW="720px">
      <DialogFrame title={R.title(next)} context={draft ? R.summary(changes.length, draft.base) : undefined}>
        {!draft ? (
          <Text color="fg.muted">{R.nothing}</Text>
        ) : (
          <>
            <ChangeChips changes={changes} conflicts={draft.conflicts} />
            <DiffView before={draft.baseDocument} after={draft.document} label={R.file} />
            <Checks validate={validate} />
            {publish.isError && <Problem {...refusalText(settingsRefusal(publish.error))} />}
            <Field.Root>
              <Field.Label textStyle="label-sm">{R.note}</Field.Label>
              <Input value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} h="10" borderColor="border.emphasized" />
              <Field.HelperText textStyle="text-xs" color="fg.subtle">
                {R.noteHelp}
              </Field.HelperText>
            </Field.Root>
          </>
        )}
      </DialogFrame>
      <Dialog.Footer px="6" py="4" gap="2">
        <Flex me="auto">
          {draft && <DownloadButton label={R.download} run={() => downloadSettings(draft.document, null, R.draftSource(draft.base))} />}
          {logo && <DownloadButton label={R.downloadLogo} run={() => downloadLogo(logo)} />}
        </Flex>
        <Button variant="outline" size="sm" h="10" onClick={close} disabled={publish.isPending}>
          {R.keepEditing}
        </Button>
        <Button colorPalette="brand" size="sm" h="10" loading={publish.isPending} disabled={blocked} onClick={apply}>
          <Check size={16} aria-hidden />
          {R.apply(next)}
        </Button>
      </Dialog.Footer>
    </DialogShell>
  );
}
