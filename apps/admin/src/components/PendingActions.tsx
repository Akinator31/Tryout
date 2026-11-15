// The header actions of every settings page: Discard and "Review N changes",
// shown while the draft holds changes.
import { Button, Flex } from "@chakra-ui/react";
import { Check } from "lucide-react";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

/** Discard and Review, or nothing when no change is pending. */
export function PendingActions() {
  const { changes, discard, openReview } = useDraft();
  if (changes.length === 0) return null;

  return (
    <Flex gap="2">
      <Button variant="ghost" size="sm" h="10" onClick={discard}>
        {strings.draft.discard}
      </Button>
      <Button colorPalette="brand" size="sm" h="10" onClick={openReview}>
        <Check size={16} aria-hidden />
        {strings.draft.review(changes.length)}
      </Button>
    </Flex>
  );
}
