// Signing in and out: the redirect to sign in, the way back, the messages.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderAdmin, signedIn, type Routes } from "./support.tsx";

/** Routes where nobody is signed in until login succeeds. */
function signedOut(login: Routes[string]): Routes {
  let session = false;
  const routes = signedIn();
  return {
    ...routes,
    "GET me": () => (session ? (routes["GET me"] as { status: number; body: unknown }) : { status: 401, body: { error: "sign in first" } }),
    "POST login": (call) => {
      const answer = typeof login === "function" ? login(call) : login;
      if (answer.status === 200) session = true;
      return answer;
    },
  };
}

/** Fills and sends the sign-in form. */
async function signIn(user: ReturnType<typeof userEvent.setup>, password = "correct horse battery") {
  await user.type(await screen.findByLabelText(/account/i), "alice");
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

test("a signed-out visit goes to sign in, then back to the page it asked for", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin("/admin/accounts", signedOut({ status: 200, body: { name: "alice" } }));

  await signIn(user);

  expect(await screen.findByRole("heading", { name: "Accounts" })).toBeTruthy();
  expect(calls.find((c) => c.path === "login")?.body).toEqual({ name: "alice", password: "correct horse battery" });
});

test("a wrong password says so and clears the field", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/sign-in", signedOut({ status: 401, body: { error: "wrong account or password" } }));

  await signIn(user, "nope nope nope");

  expect((await screen.findByRole("alert")).textContent).toContain("Wrong account or password");
  expect((screen.getByLabelText(/password/i) as HTMLInputElement).value).toBe("");
});

test("too many attempts tell when to try again", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/sign-in", signedOut({ status: 429, body: { error: "too many attempts" }, headers: { "retry-after": "690" } }));

  await signIn(user);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Too many attempts");
  expect(alert.textContent).toContain("Try again in 12 min.");
});

test("signing out ends the session and shows the sign-in page", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin("/admin/sessions", signedIn({ "POST logout": { status: 204 } }));

  await user.click(await screen.findByRole("button", { name: "Sign out" }));

  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(calls.some((c) => c.method === "POST" && c.path === "logout")).toBe(true);
});

test("the sidebar shows the version, the revision and the control plane's state", async () => {
  renderAdmin("/admin/sessions", signedIn());

  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Version 0.2.0, revision 15"));
  expect(screen.getByRole("status").textContent).toContain("Control plane healthy");
});
