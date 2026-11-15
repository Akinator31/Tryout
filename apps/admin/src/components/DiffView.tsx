// A YAML diff panel, from the Figma "Review & apply" and "Revisions" screens:
// a header with the file and the counts, then the changed lines with two
// lines of context, red for removed and green for added.
import { Box, Flex, Text } from "@chakra-ui/react";
import { useMemo } from "react";
import { lineCounts, lineDiff, withContext, type DiffLine } from "../settings/diff.ts";
import type { SettingsDocument } from "../settings/document.ts";
import { yamlLines } from "../settings/yaml.ts";
import { strings } from "../strings.ts";

const STYLES: Record<DiffLine["kind"], { bg?: string; color: string; sign: string }> = {
  same: { color: "fg.muted", sign: " " },
  remove: { bg: "bg.error", color: "fg", sign: "-" },
  add: { bg: "bg.success", color: "fg", sign: "+" },
};

/** One line of the diff, or the mark of lines left out. */
function Line({ line }: { line: DiffLine | null }) {
  if (!line) {
    return (
      <Text px="3" color="fg.subtle" aria-hidden>
        …
      </Text>
    );
  }

  const style = STYLES[line.kind];
  return (
    <Flex bg={style.bg} color={style.color} px="3" whiteSpace="pre">
      <Box as="span" w="4" flexShrink="0" color={line.kind === "same" ? "fg.subtle" : style.color}>
        {style.sign}
      </Box>
      <span>{line.text}</span>
    </Flex>
  );
}

interface DiffViewProps {
  before: SettingsDocument;
  after: SettingsDocument;
  label: string;
  /** Text shown instead when nothing changed. */
  empty?: string;
  maxH?: string;
}

/** The YAML lines that differ between two documents. */
export function DiffView({ before, after, label, empty, maxH = "320px" }: DiffViewProps) {
  const lines = useMemo(() => lineDiff(yamlLines(before), yamlLines(after)), [before, after]);
  const { added, removed } = lineCounts(lines);

  if (added + removed === 0) return <Text color="fg.muted">{empty ?? strings.review.nothing}</Text>;

  return (
    <Box borderWidth="1px" borderColor="border" borderRadius="l2" overflow="hidden" bg="bg">
      <Flex px="3" py="1.5" borderBottomWidth="1px" borderColor="border" bg="bg.muted" textStyle="mono-xs" color="fg.muted">
        <Text flex="1">{label}</Text>
        <Text>{`+${added} −${removed}`}</Text>
      </Flex>
      <Box maxH={maxH} overflow="auto" py="1" textStyle="mono-sm" role="region" aria-label={label}>
        {withContext(lines).map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </Box>
    </Box>
  );
}
