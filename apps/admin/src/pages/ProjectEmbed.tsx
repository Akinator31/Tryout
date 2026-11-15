// The project page's right column cards, from the Figma "Project — cli-hello"
// screens: Preview runs the real embed page in a frame, on click only, so it
// takes a slot through the queue like a visitor; Embed gives the address and
// the iframe snippet for a portfolio.
import { Box, Button, Flex, Heading, IconButton, Link, Stack, Text } from "@chakra-ui/react";
import { Copy, Play, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { Card, Footnote } from "../components/Card.tsx";
import { TagBadge } from "../components/StateBadge.tsx";
import { paths } from "../navigation.ts";
import { embedAddress, IFRAME_ALLOW, iframeSnippet, previewBlock, type PreviewInput } from "../preview.ts";
import { strings } from "../strings.ts";
import { useCopy } from "../useCopy.ts";

const P = strings.project.preview;
const E = strings.project.embed;

/** A right column card: its title, an optional action, then its body. */
function SideCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card as="section" aria-label={title}>
      <Flex px="5" h="53px" align="center" gap="3" borderBottomWidth="1px" borderColor="border">
        <Heading as="h2" textStyle="heading-md" flex="1">
          {title}
        </Heading>
        {action}
      </Flex>
      {children}
    </Card>
  );
}

/** What the preview says before it starts, and why it cannot when it cannot. */
function NotStarted({ name, slots, block, adminOrigin, onStart }: { name: string; slots: number; block: ReturnType<typeof previewBlock>; adminOrigin: string; onStart: () => void }) {
  const reason = block === "parent" ? P.blocked.parent(adminOrigin) : block ? P.blocked[block] : null;

  return (
    <Stack m="4" p="5" gap="3" align="flex-start" bg="bg" borderWidth="1px" borderColor="border" borderRadius="l3" minH="220px" justify="center">
      <Text textStyle="label-md">{P.heading}</Text>
      <Text textStyle="text-sm" color="fg.muted">
        {reason ?? P.body(name, slots)}
      </Text>
      <Flex gap="3" align="center">
        <Button variant="outline" size="sm" h="10" disabled={block !== null} onClick={onStart}>
          <Play size={16} aria-hidden />
          {P.start}
        </Button>
        {block === "parent" && (
          <Link asChild textStyle="text-sm" color="fg.muted">
            <RouterLink to={paths.embedding}>{P.embedding}</RouterLink>
          </Link>
        )}
      </Flex>
    </Stack>
  );
}

/**
 * Runs /embed/<project> in a frame once started; stopping removes the frame,
 * and the embed page gives its ticket back as it unloads. Keyed by project,
 * so another project's page starts stopped.
 */
export function PreviewCard({ name, slots, input }: { name: string; slots: number; input: PreviewInput }) {
  const [running, setRunning] = useState(false);
  const block = previewBlock(input);
  // Paused or refused meanwhile: the frame goes, and does not come back on its own.
  if (running && block !== null) setRunning(false);
  const shown = running && block === null;

  const stop = (
    <Button variant="ghost" size="xs" onClick={() => setRunning(false)}>
      <Square size={14} aria-hidden />
      {P.stop}
    </Button>
  );

  return (
    <SideCard title={P.title} action={shown ? stop : undefined}>
      {shown ? (
        <>
          <Box asChild display="block" w="full" aspectRatio="16 / 10" border="0" bg="bg">
            <iframe src={embedAddress(input.publicUrl, name)} title={P.frame(name)} allow={IFRAME_ALLOW} />
          </Box>
          <Footnote>{P.refused}</Footnote>
        </>
      ) : (
        <NotStarted name={name} slots={slots} block={block} adminOrigin={input.adminOrigin} onStart={() => setRunning(true)} />
      )}
    </SideCard>
  );
}

/** The address to embed with a copy button, the allowed parents, and the iframe snippet to copy. */
export function EmbedCard({ name, publicUrl, ancestors }: { name: string; publicUrl: string | null; ancestors: readonly string[] }) {
  const address = embedAddress(publicUrl, name);
  const addressCopy = useCopy();
  const snippetCopy = useCopy();

  return (
    <SideCard title={E.title}>
      <Stack px="5" py="4" gap="3" align="flex-start">
        <Flex w="full" pl="3" pr="1" h="10" align="center" gap="2" bg="bg" borderWidth="1px" borderColor="border" borderRadius="l2">
          <Text flex="1" textStyle="mono-sm" truncate title={address}>
            {address}
          </Text>
          <IconButton variant="ghost" size="xs" color="fg.muted" aria-label={addressCopy.copied ? E.copied : E.copyAddress} onClick={() => addressCopy.copy(address)}>
            <Copy size={14} aria-hidden />
          </IconButton>
        </Flex>
        {!publicUrl && (
          <Text textStyle="text-xs" color="fg.subtle">
            {E.noUrl}
          </Text>
        )}
        <Text textStyle="text-xs" color="fg.muted">
          {E.parents}
        </Text>
        <Flex gap="1.5" wrap="wrap">
          {["'self'", ...ancestors].map((origin) => (
            <TagBadge key={origin}>{origin}</TagBadge>
          ))}
        </Flex>
        <Button variant="outline" size="sm" h="8" onClick={() => snippetCopy.copy(iframeSnippet(address))}>
          <Copy size={16} aria-hidden />
          {snippetCopy.copied ? E.copied : E.copySnippet}
        </Button>
      </Stack>
    </SideCard>
  );
}
