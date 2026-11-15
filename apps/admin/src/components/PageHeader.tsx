import { Box, Flex, Heading, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description: string;
  /** The page's main action, on the right. */
  action?: ReactNode;
}

/** A page's title and one-line description, with its main action if any. */
export function PageHeader({ title, description, action }: PageHeaderProps) {
  return (
    <Flex as="header" px="8" py="6" gap="4" align="flex-start">
      <Box flex="1">
        <Heading as="h1" textStyle="heading-2xl">
          {title}
        </Heading>
        <Text mt="1" color="fg.muted">
          {description}
        </Text>
      </Box>
      {action && <Box pt="4">{action}</Box>}
    </Flex>
  );
}
