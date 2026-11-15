// The trail above a page inside a section: the section's link, then the page.
import { Flex, Link, Text } from "@chakra-ui/react";
import { ChevronRight } from "lucide-react";
import { Link as RouterLink } from "react-router";

/** "Projects › cli-hello", in a bar across the top of the page. */
export function Breadcrumb({ parent, to, current }: { parent: string; to: string; current: string }) {
  return (
    <Flex as="nav" aria-label="Breadcrumb" h="14" px="8" gap="3" align="center" borderBottomWidth="1px" borderColor="border" textStyle="text-sm">
      <Link asChild color="fg.muted">
        <RouterLink to={to}>{parent}</RouterLink>
      </Link>
      <ChevronRight size={14} aria-hidden />
      <Text aria-current="page">{current}</Text>
    </Flex>
  );
}
