import { Badge, Box } from "@chakra-ui/react";
import type { Session } from "../model.ts";
import type { NodeState } from "../nodes.ts";
import type { ProjectState } from "../projects.ts";
import { strings } from "../strings.ts";

/** A badge in a colour palette; `dot` marks something live. */
export function DotBadge({ palette, dot, children }: { palette: string; dot: boolean; children: string }) {
  const gray = palette === "gray";

  return (
    <Badge
      colorPalette={palette}
      variant="subtle"
      size="sm"
      borderRadius="l1"
      px="2"
      gap="1.5"
      textStyle="label-xs"
      color={gray ? "fg.muted" : `${palette}.fg`}
      bg={gray ? "bg.emphasized" : undefined}
      flexShrink="0"
    >
      {dot && <Box w="1.5" h="1.5" borderRadius="full" bg="currentColor" aria-hidden />}
      {children}
    </Badge>
  );
}

const SESSION_PALETTES: Record<Session["state"], string> = { active: "green", starting: "brand", waiting: "gray" };

/** A ticket's state: green and dotted when live, amber and dotted when starting, gray when waiting. */
export function StateBadge({ state, label }: { state: Session["state"]; label: string }) {
  return (
    <DotBadge palette={SESSION_PALETTES[state]} dot={state !== "waiting"}>
      {label}
    </DotBadge>
  );
}

const PROJECT_PALETTES: Record<ProjectState, string> = { running: "green", ready: "green", full: "brand", offline: "red", paused: "gray", draft: "gray" };

/** A project's state: dotted while visitors can be served or are refused by a down node; gray when paused or not applied. */
export function ProjectBadge({ state }: { state: ProjectState }) {
  return (
    <DotBadge palette={PROJECT_PALETTES[state]} dot={state !== "paused" && state !== "draft"}>
      {strings.projects.states[state]}
    </DotBadge>
  );
}

const NODE_PALETTES: Record<NodeState, string> = { healthy: "green", unreachable: "red", unchecked: "gray", draft: "gray" };

/** A node's state: green when it answers, red when not, gray before its first check. */
export function NodeBadge({ state }: { state: NodeState }) {
  return (
    <DotBadge palette={NODE_PALETTES[state]} dot={state === "healthy" || state === "unreachable"}>
      {strings.nodes.states[state]}
    </DotBadge>
  );
}

/** A plain gray badge, such as "you" or "admin". */
export function TagBadge({ children }: { children: string }) {
  return (
    <DotBadge palette="gray" dot={false}>
      {children}
    </DotBadge>
  );
}
