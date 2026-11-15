import { Box } from "@chakra-ui/react";

/** How full something is, as a thin amber bar: `used` of `max`, capped at full. */
export function LoadBar({ used, max, w = "100px" }: { used: number; max: number; w?: string }) {
  const percent = max > 0 ? Math.min(100, (used / max) * 100) : 0;

  return (
    <Box w={w} h="1" mt="1.5" bg="bg.emphasized" borderRadius="full" overflow="hidden" aria-hidden>
      <Box h="full" w={`${percent}%`} bg="brand.solid" />
    </Box>
  );
}
