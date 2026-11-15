// A block of text to copy, such as a YAML excerpt: a small header with its
// label and a Copy button, then the text in mono.
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Copy } from "lucide-react";
import { strings } from "../strings.ts";
import { useCopy } from "../useCopy.ts";
import { Card } from "./Card.tsx";

/** The text under its label, with a Copy button that says when it copied. */
export function CodeBlock({ label, text }: { label: string; text: string }) {
  const { copied, copy } = useCopy();

  return (
    <Card>
      <Flex px="3" py="1.5" align="center" borderBottomWidth="1px" borderColor="border" bg="bg.muted">
        <Text flex="1" textStyle="text-xs" color="fg.muted">
          {label}
        </Text>
        <Button variant="ghost" size="xs" color="fg.muted" onClick={() => copy(text)}>
          <Copy size={14} aria-hidden />
          {copied ? strings.projectForm.copied : strings.projectForm.copy}
        </Button>
      </Flex>
      <Box as="pre" px="4" py="3" textStyle="mono-sm" whiteSpace="pre" overflowX="auto">
        {text}
      </Box>
    </Card>
  );
}
