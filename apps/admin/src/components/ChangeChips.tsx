// The summary of a set of changes, as chips: green for added, red for
// removed, amber for changed; a change both sides made is outlined in red.
import { Badge, Flex } from "@chakra-ui/react";
import type { Change } from "../settings/diff.ts";
import { isConflict } from "../settings/draft.ts";
import { changeLabel, changeSign } from "../settings/labels.ts";
import { strings } from "../strings.ts";

const PALETTES: Record<Change["kind"], string> = { add: "green", remove: "red", change: "brand" };

/** One chip per change. */
export function ChangeChips({ changes, conflicts = [] }: { changes: Change[]; conflicts?: string[][] }) {
  return (
    <Flex as="ul" wrap="wrap" gap="2" listStyleType="none">
      {changes.map((change, i) => {
        const palette = PALETTES[change.kind];
        const conflict = isConflict(change, conflicts);

        return (
          <Badge
            as="li"
            key={i}
            colorPalette={palette}
            variant="subtle"
            size="sm"
            borderRadius="l1"
            px="2"
            textStyle="label-xs"
            color={`${palette}.fg`}
            borderWidth={conflict ? "1px" : undefined}
            borderColor={conflict ? "fg.error" : undefined}
          >
            {`${changeSign(change)} ${changeLabel(change)}`}
            {conflict && ` (${strings.review.conflict})`}
          </Badge>
        );
      })}
    </Flex>
  );
}
