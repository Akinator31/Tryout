import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Outlet, useNavigate } from "react-router";
import { isSignedOut } from "../api.ts";
import { Problem } from "../components/Problem.tsx";
import { paths } from "../navigation.ts";
import { useMe, useSignOut } from "../queries.ts";
import { strings } from "../strings.ts";
import { Sidebar } from "./Sidebar.tsx";

/**
 * The signed-in frame: the sidebar and the current page. It first asks who is
 * signed in; a 401 there sends the browser to sign in (see SignedOutRedirect).
 */
export function Shell() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();

  /** Ends the session, then shows the sign-in page, even when the call failed. */
  const onSignOut = () => signOut.mutate(undefined, { onSettled: () => navigate(paths.signIn, { replace: true }) });

  if (me.isPending || isSignedOut(me.error)) {
    return (
      <Text p="8" color="fg.muted">
        {strings.shell.loading}
      </Text>
    );
  }
  if (me.isError) {
    return (
      <Box p="8" maxW="480px">
        <Problem title={strings.common.loadFailed} detail={me.error.message} />
        <Button mt="4" variant="outline" size="sm" onClick={() => me.refetch()}>
          {strings.common.retry}
        </Button>
      </Box>
    );
  }

  return (
    <Flex minH="100vh">
      <Sidebar onSignOut={onSignOut} />
      <Box as="main" flex="1" minW="0" pb="8">
        <Outlet />
      </Box>
    </Flex>
  );
}
