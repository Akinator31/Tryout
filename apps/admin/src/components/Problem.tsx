import { Box, Flex, Text } from "@chakra-ui/react";
import { TriangleAlert } from "lucide-react";

interface ProblemProps {
  title: string;
  detail?: string;
}

/** Why something failed: a bordered box with the alert icon, the fact in red, then the detail. */
export function Problem({ title, detail }: ProblemProps) {
  return (
    <Flex role="alert" gap="3" p="4" borderWidth="1px" borderColor="border.emphasized" borderRadius="l2">
      <Box color="fg.error" pt="0.5">
        <TriangleAlert size={16} aria-hidden />
      </Box>
      <Box>
        <Text textStyle="label-sm" color="fg.error">
          {title}
        </Text>
        {detail && (
          <Text mt="0.5" color="fg.muted">
            {detail}
          </Text>
        )}
      </Box>
    </Flex>
  );
}
