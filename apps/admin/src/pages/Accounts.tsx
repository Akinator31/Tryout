// The accounts page, from the Figma "Accounts" screen: the accounts, adding
// and deleting one, and changing one's own password.
import { Box, Button, Dialog, Field, Flex, Heading, Input, Portal, Stack, Table, Text } from "@chakra-ui/react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError } from "../api.ts";
import { useNow } from "../clock.ts";
import { Card, Footnote } from "../components/Card.tsx";
import { ConfirmDialog, DialogFrame } from "../components/ConfirmDialog.tsx";
import { DataCell, DataHeader, DataTable } from "../components/DataTable.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Problem } from "../components/Problem.tsx";
import { TagBadge } from "../components/StateBadge.tsx";
import { daysAgo } from "../format.ts";
import type { Account } from "../model.ts";
import { useAccounts, useChangePassword, useCreateAccount, useDeleteAccount, useMe } from "../queries.ts";
import { strings } from "../strings.ts";

const A = strings.accounts;
const MINUTE = 60_000;

/** The message for a failed account action: the server's own for a refused input, else a generic one. */
function actionProblem(e: unknown): string {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 ? e.message : strings.common.actionFailed;
}

/** One account's row; the signed-in account is marked and cannot delete itself here. */
function AccountRow({ account, isMe, now, onDelete }: { account: Account; isMe: boolean; now: number; onDelete: () => void }) {
  return (
    <Table.Row bg="transparent">
      <DataCell w="276px">
        <Flex gap="2" align="center">
          <Text textStyle="mono-sm">{account.name}</Text>
          {isMe && <TagBadge>{A.you}</TagBadge>}
        </Flex>
      </DataCell>
      <DataCell muted>{daysAgo(account.created_at, now)}</DataCell>
      <DataCell textAlign="end">
        {!isMe && (
          <Button variant="ghost" size="sm" h="8" px="3" aria-label={A.deleteLabel(account.name)} onClick={onDelete}>
            <Trash2 size={16} aria-hidden />
            {A.delete}
          </Button>
        )}
      </DataCell>
    </Table.Row>
  );
}

/** Asks before deleting `name`; its sessions end at once. */
function DeleteDialog({ name, onClose }: { name: string | null; onClose: () => void }) {
  const remove = useDeleteAccount();

  /** Closes the dialog and forgets the last attempt. */
  const close = () => {
    remove.reset();
    onClose();
  };

  return (
    <ConfirmDialog
      open={name !== null}
      title={name ? A.deleteDialog.title(name) : ""}
      confirmLabel={A.deleteDialog.confirm}
      confirmIcon={<Trash2 size={16} aria-hidden />}
      pending={remove.isPending}
      onConfirm={() => name && remove.mutate(name, { onSuccess: close })}
      onClose={close}
    >
      <Text>{A.deleteDialog.body}</Text>
      {remove.isError && <Problem title={actionProblem(remove.error)} />}
    </ConfirmDialog>
  );
}

/** A labelled input with its help text, for the account forms. */
function TextField(props: {
  label: string;
  help?: string;
  type?: "text" | "password";
  autoComplete: string;
  mono?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const { label, help, type = "text", autoComplete, mono, value, onChange } = props;

  return (
    <Field.Root required>
      <Field.Label textStyle="label-sm">{label}</Field.Label>
      <Input
        type={type}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        fontFamily={mono ? "mono" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        h="10"
        borderColor="border.emphasized"
      />
      {help && (
        <Field.HelperText textStyle="text-xs" color="fg.subtle">
          {help}
        </Field.HelperText>
      )}
    </Field.Root>
  );
}

/** The form that adds an account, in a dialog. */
function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const exists = create.error instanceof ApiError && create.error.status === 409;

  /** Closes the dialog, emptying the form. */
  const close = () => {
    create.reset();
    setName("");
    setPassword("");
    onClose();
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ name: name.trim(), password }, { onSuccess: close });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} placement="center" lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.700" />
        <Dialog.Positioner>
          <Dialog.Content bg="bg.subtle" borderWidth="1px" borderColor="border.emphasized" borderRadius="l3" maxW="480px" shadow="none">
            <form onSubmit={submit} noValidate>
              <DialogFrame title={A.addDialog.title}>
                {create.isError && <Problem title={exists ? A.addDialog.exists : actionProblem(create.error)} />}
                <TextField label={A.addDialog.name} help={A.addDialog.nameHelp} autoComplete="off" mono value={name} onChange={setName} />
                <TextField label={A.addDialog.password} help={A.addDialog.passwordHelp} type="password" autoComplete="new-password" value={password} onChange={setPassword} />
              </DialogFrame>
              <Dialog.Footer px="6" py="4" gap="2">
                <Button variant="outline" size="sm" h="10" onClick={close} disabled={create.isPending}>
                  {strings.common.cancel}
                </Button>
                <Button type="submit" colorPalette="brand" size="sm" h="10" loading={create.isPending} disabled={!name.trim() || !password}>
                  <Plus size={16} aria-hidden />
                  {A.addDialog.confirm}
                </Button>
              </Dialog.Footer>
            </form>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** The signed-in account's password form; a change signs out its other sessions. */
function PasswordCard() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const wrongCurrent = change.error instanceof ApiError && change.error.status === 403;

  function submit(e: FormEvent) {
    e.preventDefault();
    change.mutate(
      { current, password: next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
        },
      },
    );
  }

  return (
    <Card w="420px" flexShrink="0">
      <Box px="5" py="4" borderBottomWidth="1px" borderColor="border">
        <Heading as="h2" textStyle="heading-md">
          {A.password.title}
        </Heading>
        <Text mt="0.5" textStyle="text-xs" color="fg.subtle">
          {A.password.description}
        </Text>
      </Box>
      <form onSubmit={submit} noValidate>
        <Stack gap="4" p="5">
          {change.isError && <Problem title={wrongCurrent ? A.password.wrongCurrent : actionProblem(change.error)} />}
          <TextField label={A.password.current} type="password" autoComplete="current-password" value={current} onChange={setCurrent} />
          <TextField label={A.password.next} help={A.password.help} type="password" autoComplete="new-password" value={next} onChange={setNext} />
          <Box>
            <Button type="submit" variant="outline" size="sm" h="10" loading={change.isPending} disabled={!current || !next}>
              <KeyRound size={16} aria-hidden />
              {A.password.submit}
            </Button>
          </Box>
          {change.isSuccess && (
            <Text role="status" textStyle="text-xs" color="fg.success">
              {A.password.changed}
            </Text>
          )}
        </Stack>
      </form>
    </Card>
  );
}

/** Every account, with adding, deleting and the own password. */
export function Accounts() {
  const accounts = useAccounts();
  const me = useMe().data;
  const now = useNow(MINUTE);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const addButton = (
    <Button colorPalette="brand" size="sm" h="10" onClick={() => setAdding(true)}>
      <Plus size={16} aria-hidden />
      {A.add}
    </Button>
  );

  return (
    <>
      <PageHeader title={A.title} description={A.description} action={addButton} />

      <Flex px="8" gap="6" align="flex-start">
        <Box flex="1" minW="0">
          {accounts.isError && <Problem title={strings.common.loadFailed} detail={accounts.error.message} />}
          {accounts.data && (
            <Card>
              <DataTable label={A.title}>
                <Table.Header>
                  <Table.Row bg="transparent">
                    <DataHeader>{A.columns.account}</DataHeader>
                    <DataHeader>{A.columns.created}</DataHeader>
                    <DataHeader>
                      <Box srOnly>{A.columns.actions}</Box>
                    </DataHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {accounts.data.map((a) => (
                    <AccountRow key={a.name} account={a} isMe={a.name === me?.name} now={now} onDelete={() => setDeleting(a.name)} />
                  ))}
                </Table.Body>
              </DataTable>
              <Footnote>{A.footnote}</Footnote>
            </Card>
          )}
        </Box>
        <PasswordCard />
      </Flex>

      <AddDialog open={adding} onClose={() => setAdding(false)} />
      <DeleteDialog name={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
