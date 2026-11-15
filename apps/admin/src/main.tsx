// Entry point: Emotion's cache takes the CSP nonce the control plane put in
// the page, so the styles Chakra inserts at run time are allowed.
import createCache from "@emotion/cache";
import "@tryout/tokens/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api.ts";
import { App } from "./app/App.tsx";

/** The nonce of this answer, or undefined under `npm run dev`, which serves the placeholder. */
function cspNonce(): string | undefined {
  const value = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
  return value && value !== "__CSP_NONCE__" ? value : undefined;
}

const cache = createCache({ key: "tryout", nonce: cspNonce() });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={createApiClient()} cache={cache} />
  </StrictMode>,
);
