import { Badge, Box } from "@chakra-ui/react";
import type { Session } from "../model.ts";

const PALETTES: Record<Session["state"], string> = { active: "green", starting: "brand", waiting: "gray" };

/** A ticket's state: green and dotted when live, amber and dotted when starting, gray when waiting. */
export function StateBadge({ state, label }: { state: Session["state"]; label: string }) {
  const palette = PALETTES[state];

  return (
    <Badge colorPalette={palette} variant="subtle" size="sm" borderRadius="l1" px="2" gap="1.5" textStyle="label-xs" color={`${palette}.fg`}>
      {state !== "waiting" && <Box w="1.5" h="1.5" borderRadius="full" bg="currentColor" aria-hidden />}
      {label}
    </Badge>
  );
}

/** A plain gray badge, such as "you" or "admin". */
export function TagBadge({ children }: { children: string }) {
  return (
    <Badge colorPalette="gray" variant="subtle" size="sm" borderRadius="l1" px="2" bg="bg.emphasized" color="fg.muted" textStyle="label-xs">
      {children}
    </Badge>
  );
}
