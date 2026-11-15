// The "Review and apply" dialog, from the Figma screen of that name: the
// draft's changes as chips and a YAML diff, the server's dry run, a note, and
// Apply, which publishes the draft as the next revision.
import { Box, Button, Dialog, Field, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../api.ts";
import { usePublish, useValidate } from "../queries.ts";
import { downloadSettings } from "../settings/download.ts";
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

/** The problems of a refused document (422), or null for any other error. */
function problemsOf(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.status !== 422) return null;
  const { problems } = e.details;
  return Array.isArray(problems) ? problems.map(String) : [e.message];
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
    const problems = problemsOf(validate.error);
    return <Problem title={problems ? R.invalid : R.checkFailed} detail={problems?.join(" ") ?? validate.error.message} />;
  }

  const { warnings } = validate.data;
  const unreachable = warnings.some((w) => w.includes("does not answer"));
  return (
    <Stack gap="1.5" role="status">
      <CheckLine ok>{R.valid}</CheckLine>
      {!unreachable && <CheckLine ok>{R.reachable}</CheckLine>}
      {warnings.map((w) => (
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
  const [moved, setMoved] = useState(false);

  // Check the draft each time the dialog opens, and again if it changes meanwhile (moved on top of a newer revision).
  const document = reviewing ? draft?.document : undefined;
  useEffect(() => {
    if (document) validate.mutate(document);
  }, [document]);

  // Fill the note from the changes when the dialog opens.
  useEffect(() => {
    if (reviewing) setNote(noteFrom(changes, MAX_NOTE));
  }, [reviewing]);

  /** Closes the dialog and forgets the last attempt; the draft stays. */
  const close = () => {
    publish.reset();
    setMoved(false);
    closeReview();
  };

  /** Publishes the draft; a 409 means a newer revision exists, which the draft then moves onto. */
  const apply = () => {
    if (!draft) return;

    setMoved(false);
    publish.mutate(
      { base: draft.base, document: draft.document, note: note.trim() || undefined },
      {
        onSuccess: () => {
          discard();
          close();
        },
        onError: (e) => setMoved(e instanceof ApiError && e.status === 409),
      },
    );
  };

  const next = (draft?.base ?? 0) + 1;
  const publishProblems = problemsOf(publish.error);
  const blocked = !draft || validate.isPending || validate.isError || publish.isPending;

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
            {moved && <Problem title={R.moved} />}
            {publish.isError && !moved && <Problem title={publishProblems ? R.invalid : strings.common.actionFailed} detail={publishProblems?.join(" ")} />}
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
        <Box me="auto">
          {draft && <DownloadButton label={R.download} run={() => downloadSettings(draft.document, null, R.draftSource(draft.base))} />}
        </Box>
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
