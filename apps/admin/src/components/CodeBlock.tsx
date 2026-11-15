// A block of text to copy, such as a YAML excerpt: a small header with its
// label and a Copy button, then the text in mono.
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Copy } from "lucide-react";
import { useState } from "react";
import { strings } from "../strings.ts";
import { Card } from "./Card.tsx";

/** The text under its label, with a Copy button that says when it copied. */
export function CodeBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);

  /** Copies the text; the button says so for two seconds. */
  const copy = async () => {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <Flex px="3" py="1.5" align="center" borderBottomWidth="1px" borderColor="border" bg="bg.muted">
        <Text flex="1" textStyle="text-xs" color="fg.muted">
          {label}
        </Text>
        <Button variant="ghost" size="xs" color="fg.muted" onClick={copy}>
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
