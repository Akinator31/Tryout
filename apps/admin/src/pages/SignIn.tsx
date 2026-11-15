// The sign-in page, from the Figma "Sign in" and "Sign in — refused" screens.
import { Box, Button, Field, Flex, Heading, Image, Input, Stack, Text } from "@chakra-ui/react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import logo from "../logo.svg";
import { Card } from "../components/Card.tsx";
import { Problem } from "../components/Problem.tsx";
import { TagBadge } from "../components/StateBadge.tsx";
import { canSignIn, safeNext } from "../navigation.ts";
import { useSignIn } from "../queries.ts";
import { signInProblem } from "../signin.ts";
import { strings } from "../strings.ts";

/**
 * Opens a session, then returns to the page that asked for it. Over plain
 * HTTP on a host other than localhost, the browser would drop the cookie:
 * the page says so before anything is sent.
 */
export function SignIn() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useSignIn();
  const secure = canSignIn(window.location);

  /** Sends the credentials, once both are filled; a failure keeps the name and clears the password. */
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !password) return;

    signIn.mutate(
      { name: name.trim(), password },
      {
        onSuccess: () => navigate(safeNext(params.get("next")), { replace: true }),
        onError: () => setPassword(""),
      },
    );
  }

  const problem = !secure ? strings.signIn.insecure : signIn.isError ? signInProblem(signIn.error) : null;

  return (
    <Flex minH="100vh" justify="center" pt="27vh" px="4">
      <Box w="360px">
        <Flex gap="2.5" align="center" mb="8">
          <Image src={logo} alt={strings.brand.name} h="28px" w="97px" />
          <TagBadge>{strings.brand.badge}</TagBadge>
        </Flex>

        <Card p="6">
          <form onSubmit={submit} noValidate>
            <Stack gap="4">
              <Heading as="h1" textStyle="heading-lg">
                {strings.signIn.title}
              </Heading>
              {problem && <Problem title={problem.title} detail={problem.detail} />}

              <Field.Root required>
                <Field.Label textStyle="label-sm">{strings.signIn.account}</Field.Label>
                <Input
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  fontFamily="mono"
                  placeholder="admin"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  h="10"
                  borderColor="border.emphasized"
                />
              </Field.Root>

              <Field.Root required>
                <Field.Label textStyle="label-sm">{strings.signIn.password}</Field.Label>
                <Input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  h="10"
                  borderColor="border.emphasized"
                />
              </Field.Root>

              <Button type="submit" colorPalette="brand" h="10" loading={signIn.isPending} disabled={!secure}>
                {strings.signIn.submit}
              </Button>
            </Stack>
          </form>
        </Card>

        <Text mt="8" textStyle="text-xs" color="fg.subtle">
          {strings.signIn.noAccount}
        </Text>
      </Box>
    </Flex>
  );
}
