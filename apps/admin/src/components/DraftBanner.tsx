// The notice shown over every page once the draft moved on top of a revision
// published meanwhile, with how many values both sides changed.
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { TriangleAlert } from "lucide-react";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

/** The notice, or nothing while the draft applies on top of the revision it was made from. */
export function DraftBanner() {
  const { draft, openReview } = useDraft();
  if (!draft || draft.movedFrom === null) return null;

  const conflicts = draft.conflicts.length;
  return (
    <Flex role="status" mx="8" mt="6" px="4" py="3" gap="3" align="center" borderWidth="1px" borderColor="border.emphasized" borderRadius="l2" bg="bg.subtle">
      <Box color="fg.warning">
        <TriangleAlert size={16} aria-hidden />
      </Box>
      <Text flex="1">
        {strings.draft.moved(draft.movedFrom, draft.base)}
        {conflicts > 0 && ` ${strings.draft.conflicts(conflicts)}`}
      </Text>
      <Button variant="outline" size="sm" onClick={openReview}>
        {strings.review.open}
      </Button>
    </Flex>
  );
}
