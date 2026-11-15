// The admin's navigation, from the Figma component Admin/Sidebar: brand,
// page links with their counts, the control plane's state and version, and
// the signed-in account with sign-out.
import { Box, Flex, IconButton, Image, Stack, Text } from "@chakra-ui/react";
import { Activity, Box as BoxIcon, Globe, History, LogOut, Palette, Server, User, Users, type LucideIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { NavLink } from "react-router";
import logo from "../logo.svg";
import { TagBadge } from "../components/StateBadge.tsx";
import { paths } from "../navigation.ts";
import { useActiveSettings, useApi, useMe, useSessions } from "../queries.ts";
import { countStates } from "../sessions.ts";
import { strings } from "../strings.ts";

interface NavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
  count?: number;
}

/** A page link; the current page's is highlighted. */
function NavItem({ to, icon: Icon, label, count }: NavItemProps) {
  return (
    <NavLink to={to}>
      {({ isActive }) => (
        <Flex
          h="9"
          px="3"
          gap="3"
          align="center"
          borderRadius="l2"
          bg={isActive ? "bg.emphasized" : undefined}
          color={isActive ? "fg" : "fg.muted"}
          _hover={{ color: "fg", bg: isActive ? undefined : "bg.muted" }}
          aria-current={isActive ? "page" : undefined}
        >
          <Icon size={16} aria-hidden />
          <Text flex="1" textStyle="label-sm">
            {label}
          </Text>
          {count !== undefined && (
            <Text textStyle="mono-xs" color="fg.subtle">
              {count}
            </Text>
          )}
        </Flex>
      )}
    </NavLink>
  );
}

/** The control plane's state, as the last API call saw it, with the version and active revision. */
function ControlPlaneStatus() {
  const api = useApi();
  const reachable = useSyncExternalStore(api.subscribe, api.reachable);
  const me = useMe().data;
  const revision = useActiveSettings().data?.revision ?? null;

  return (
    <Stack gap="1" p="3" borderWidth="1px" borderColor="border" borderRadius="l2" role="status">
      <Flex gap="2" align="center">
        <Box w="2" h="2" borderRadius="full" bg={reachable ? "fg.success" : "fg.error"} aria-hidden />
        <Text textStyle="label-xs">{reachable ? strings.shell.healthy : strings.shell.unreachable}</Text>
      </Flex>
      {me && (
        <Text textStyle="text-xs" color="fg.subtle">
          {strings.shell.version(me.version, revision)}
        </Text>
      )}
    </Stack>
  );
}

/** The signed-in account and its sign-out button. */
function AccountRow({ onSignOut }: { onSignOut: () => void }) {
  const me = useMe().data;

  return (
    <Flex ps="3" pe="1" py="1" gap="2" align="center">
      <User size={16} aria-hidden />
      <Text flex="1" textStyle="label-sm">
        {me?.name}
      </Text>
      <IconButton aria-label={strings.shell.signOut} title={strings.shell.signOut} variant="ghost" size="sm" color="fg.muted" onClick={onSignOut}>
        <LogOut size={16} />
      </IconButton>
    </Flex>
  );
}

/** The sidebar; Projects and Nodes count those of the active settings, Sessions those running or starting. */
export function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  const sessions = useSessions().data;
  const counts = sessions ? countStates(sessions) : null;
  const settings = useActiveSettings().data?.document;
  const count = (section?: object) => (settings ? Object.keys(section ?? {}).length : undefined);

  return (
    <Flex as="aside" direction="column" gap="1" w="248px" flexShrink="0" h="100vh" position="sticky" top="0" px="3" py="4" bg="bg.subtle" borderEndWidth="1px" borderColor="border">
      <Flex p="2" gap="2.5" align="center" mb="3">
        <Image src={logo} alt={strings.brand.name} h="24px" w="83px" />
        <TagBadge>{strings.brand.badge}</TagBadge>
      </Flex>

      <Stack as="nav" aria-label={strings.nav.label} gap="0.5">
        <NavItem to={paths.projects} icon={BoxIcon} label={strings.nav.projects} count={count(settings?.projects)} />
        <NavItem to={paths.nodes} icon={Server} label={strings.nav.nodes} count={count(settings?.nodes)} />
        <NavItem to={paths.embedding} icon={Globe} label={strings.nav.embedding} />
        <NavItem to={paths.theme} icon={Palette} label={strings.nav.theme} />
        <NavItem to={paths.sessions} icon={Activity} label={strings.nav.sessions} count={counts ? counts.active + counts.starting : undefined} />
        <NavItem to={paths.revisions} icon={History} label={strings.nav.revisions} />
        <Box h="3" />
        <NavItem to={paths.accounts} icon={Users} label={strings.nav.accounts} />
      </Stack>

      <Box flex="1" />
      <ControlPlaneStatus />
      <AccountRow onSignOut={onSignOut} />
    </Flex>
  );
}
