// The admin app: providers (styles, API, data), the router, and the rule that
// any 401 sends the browser to sign in, then back where it was.
import { ChakraProvider } from "@chakra-ui/react";
import { CacheProvider, type EmotionCache } from "@emotion/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { isRefusal, isSignedOut, type ApiClient } from "../api.ts";
import { BASE, HOME, paths, signInPath } from "../navigation.ts";
import { Accounts } from "../pages/Accounts.tsx";
import { Embedding } from "../pages/Embedding.tsx";
import { Revisions } from "../pages/Revisions.tsx";
import { Theme } from "../pages/Theme.tsx";
import { Sessions } from "../pages/Sessions.tsx";
import { SignIn } from "../pages/SignIn.tsx";
import { ApiContext } from "../queries.ts";
import { createDraftStore } from "../settings/draft.ts";
import { DraftProvider, tabStorage } from "../useDraft.tsx";
import { system } from "../theme.ts";
import { Shell } from "./Shell.tsx";

/** Retries a failed query twice, unless the server refused it (4xx): asking again would not help. */
function retry(failures: number, e: unknown): boolean {
  if (isRefusal(e)) return false;
  return failures < 2;
}

/** The data cache: queries pause while the tab is hidden, and mutations never retry. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry, refetchIntervalInBackground: false, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

/** Sends the browser to sign in when a query or mutation answers 401, keeping the page to come back to. */
function SignedOutRedirect({ client }: { client: QueryClient }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    /** Leaves for the sign-in page on a 401, unless already there. */
    function check(error: unknown) {
      if (!isSignedOut(error) || location.pathname === paths.signIn) return;
      navigate(signInPath(location.pathname + location.search + location.hash), { replace: true });
    }

    /** Checks the error of a query or mutation that just failed. */
    const onEvent = (event: { type: string; action?: { type: string; error?: unknown } }) => {
      if (event.type === "updated" && event.action?.type === "error") check(event.action.error);
    };

    const unsubscribeQueries = client.getQueryCache().subscribe(onEvent);
    const unsubscribeMutations = client.getMutationCache().subscribe(onEvent);

    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [client, navigate, location]);

  return null;
}

/** The app's pages. */
function AppRoutes() {
  return (
    <Routes>
      <Route path={paths.signIn} element={<SignIn />} />
      <Route path={BASE} element={<Shell />}>
        <Route index element={<Navigate to={HOME} replace />} />
        <Route path={paths.embedding} element={<Embedding />} />
        <Route path={paths.theme} element={<Theme />} />
        <Route path={paths.sessions} element={<Sessions />} />
        <Route path={paths.revisions} element={<Revisions />} />
        <Route path={`${paths.revisions}/:id`} element={<Revisions />} />
        <Route path={paths.accounts} element={<Accounts />} />
        <Route path="*" element={<Navigate to={HOME} replace />} />
      </Route>
      <Route path="*" element={<Navigate to={HOME} replace />} />
    </Routes>
  );
}

interface AppProps {
  api: ApiClient;
  /** Emotion's cache, carrying the page's CSP nonce. */
  cache?: EmotionCache;
  /** Tests start at a path, in memory, instead of the browser's address. */
  initialPath?: string;
  /** Where the settings draft is kept; the tab's sessionStorage by default. */
  draftStorage?: Storage | null;
}

/** Wraps `children` in Emotion's cache when one is given. */
function Styles({ cache, children }: { cache?: EmotionCache; children: ReactNode }) {
  const chakra = <ChakraProvider value={system}>{children}</ChakraProvider>;
  return cache ? <CacheProvider value={cache}>{chakra}</CacheProvider> : chakra;
}

/** The whole admin. */
export function App({ api, cache, initialPath, draftStorage = tabStorage() }: AppProps) {
  const [client] = useState(createQueryClient);
  const [drafts] = useState(() => createDraftStore(draftStorage));
  const routes = (
    <>
      <SignedOutRedirect client={client} />
      <AppRoutes />
    </>
  );

  return (
    <Styles cache={cache}>
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={client}>
          <DraftProvider store={drafts}>
            {initialPath ? <MemoryRouter initialEntries={[initialPath]}>{routes}</MemoryRouter> : <BrowserRouter>{routes}</BrowserRouter>}
          </DraftProvider>
        </QueryClientProvider>
      </ApiContext.Provider>
    </Styles>
  );
}
