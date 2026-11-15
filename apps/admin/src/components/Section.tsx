// A settings card, from the Figma settings screens: a title and one line of
// description in a bordered header, then the fields.
import { Box, Heading, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { Card } from "./Card.tsx";

interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/** A titled card of fields. */
export function Section({ title, description, children }: SectionProps) {
  return (
    <Card as="section" aria-label={title}>
      <Box px="6" py="5" borderBottomWidth="1px" borderColor="border">
        <Heading as="h2" textStyle="heading-md">
          {title}
        </Heading>
        {description && (
          <Text mt="1" color="fg.muted">
            {description}
          </Text>
        )}
      </Box>
      <Box px="6" py="5">
        {children}
      </Box>
    </Card>
  );
}

/** A side note beside the settings cards: an icon, a title and a short text. */
export function Aside({ icon, title, tone = "info", children }: { icon: ReactNode; title: string; tone?: "info" | "warning"; children: ReactNode }) {
  const color = tone === "warning" ? "fg.warning" : "fg";

  return (
    <Card as="aside" display="flex" gap="3" p="5">
      <Box color={color} pt="0.5">
        {icon}
      </Box>
      <Box>
        <Text textStyle="label-sm" color={color}>
          {title}
        </Text>
        <Text mt="1" color="fg.muted">
          {children}
        </Text>
      </Box>
    </Card>
  );
}
