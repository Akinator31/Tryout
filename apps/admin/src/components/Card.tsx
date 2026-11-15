import { Box, Flex, Text, type BoxProps } from "@chakra-ui/react";
import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** A container on the page: panel background, border, 8 px corners. */
export function Card(props: BoxProps) {
  return <Box bg="bg.subtle" borderWidth="1px" borderColor="border" borderRadius="l3" overflow="hidden" {...props} />;
}

/** A card's closing note, with the info icon. */
export function Footnote({ children }: { children: ReactNode }) {
  return (
    <Flex px="5" py="3" gap="2" align="center" color="fg.subtle">
      <Info size={14} aria-hidden />
      <Text textStyle="text-xs">{children}</Text>
    </Flex>
  );
}
