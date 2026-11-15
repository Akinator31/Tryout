import { Box, Flex, Text } from "@chakra-ui/react";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** A warning in a bordered box: the alert icon, the fact in amber, then the detail. */
export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Flex role="status" gap="3" p="4" borderWidth="1px" borderColor="border.emphasized" borderRadius="l2">
      <Box color="fg.warning" pt="0.5">
        <TriangleAlert size={16} aria-hidden />
      </Box>
      <Box>
        <Text textStyle="label-sm" color="fg.warning">
          {title}
        </Text>
        <Text mt="0.5" color="fg.muted">
          {children}
        </Text>
      </Box>
    </Flex>
  );
}
