// A dialog that asks before a destructive action: title and context in the
// header, what happens in the body, Cancel and the red action in the footer.
import { Box, Button, CloseButton, Dialog, Portal, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { strings } from "../strings.ts";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** One line under the title, such as the project and node of a session. */
  context?: string;
  /** What happens, and any error after a failed attempt. */
  children: ReactNode;
  confirmLabel: string;
  confirmIcon?: ReactNode;
  /** True while the action runs: the buttons wait. */
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Asks before an action that cannot be undone; closing it does nothing. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, context, children, confirmLabel, confirmIcon, pending, onConfirm, onClose } = props;

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" role="alertdialog" lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.700" />
        <Dialog.Positioner>
          <Dialog.Content bg="bg.subtle" borderWidth="1px" borderColor="border.emphasized" borderRadius="l3" maxW="480px" shadow="none">
            <DialogFrame title={title} context={context}>
              {children}
            </DialogFrame>
            <Dialog.Footer px="6" py="4" gap="2">
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" size="sm" h="10" disabled={pending}>
                  {strings.common.cancel}
                </Button>
              </Dialog.ActionTrigger>
              <Button colorPalette="red" variant="surface" size="sm" h="10" loading={pending} onClick={onConfirm}>
                {confirmIcon}
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** A dialog's header (title, context, close button) and bordered body. */
export function DialogFrame({ title, context, children }: { title: string; context?: string; children: ReactNode }) {
  return (
    <>
      <Dialog.Header px="6" pt="6" pb="5" borderBottomWidth="1px" borderColor="border" display="block">
        <Dialog.Title textStyle="heading-lg">{title}</Dialog.Title>
        {context && <Text mt="1">{context}</Text>}
        <Dialog.CloseTrigger asChild top="5" insetEnd="5">
          <CloseButton size="sm" aria-label={strings.common.close} />
        </Dialog.CloseTrigger>
      </Dialog.Header>
      <Dialog.Body px="6" py="5" borderBottomWidth="1px" borderColor="border">
        <Box display="flex" flexDirection="column" gap="4">
          {children}
        </Box>
      </Dialog.Body>
    </>
  );
}
