// The Sessions and Accounts pages over a fake API.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderAdmin, signedIn } from "./support.tsx";

/** Whether no dialog with `role` is open; jsdom never ends the exit animation, so a closed one may stay mounted. */
const noOpenDialog = (role: "dialog" | "alertdialog") =>
  screen.queryAllByRole(role, { hidden: true }).every((d) => d.getAttribute("data-state") === "closed");

const now = Date.now();
const SESSIONS = [
  { ticket: "7k2mq9abcdefghijklmnopqrst", project: "cli-hello", node: "local", state: "active", created_at: now - 300_000, started_at: now - 240_000, ends_at: now + 348_000 },
  { ticket: "x9e1hcabcdefghijklmnopqrst", project: "webtop", node: "local", state: "waiting", position: 1, created_at: now - 360_000 },
];

test("sessions list every live ticket with a summary", async () => {
  renderAdmin("/admin/sessions", signedIn({ "GET sessions": { status: 200, body: { sessions: SESSIONS } } }));

  expect(await screen.findByText("1 live, 0 starting, 1 waiting. 1 of 10 slots used.")).toBeTruthy();
  const table = screen.getByRole("table", { name: "Sessions" });
  expect(within(table).getByText("7k2mq9")).toBeTruthy();
  expect(within(table).getByText("waiting, 1st")).toBeTruthy();
  expect(within(table).getByText("4 min ago")).toBeTruthy();
  expect(within(table).queryByText(/abcdefghij/)).toBeNull();
});

test("stopping a session asks first, then posts the full ticket", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin(
    "/admin/sessions",
    signedIn({ "GET sessions": { status: 200, body: { sessions: SESSIONS } }, "POST sessions/7k2mq9abcdefghijklmnopqrst/stop": { status: 204 } }),
  );

  await user.click(await screen.findByRole("button", { name: "Stop session 7k2mq9" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("cli-hello on node local, started 4 min ago.")).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Stop session" }));

  await waitFor(() => expect(noOpenDialog("alertdialog")).toBe(true));
  expect(calls.some((c) => c.method === "POST" && c.path === "sessions/7k2mq9abcdefghijklmnopqrst/stop")).toBe(true);
});

test("a session that ended meanwhile is reported in the dialog", async () => {
  const user = userEvent.setup();
  renderAdmin(
    "/admin/sessions",
    signedIn({ "GET sessions": { status: 200, body: { sessions: SESSIONS } }, "POST sessions/7k2mq9abcdefghijklmnopqrst/stop": { status: 404, body: { error: "no such live session" } } }),
  );

  await user.click(await screen.findByRole("button", { name: "Stop session 7k2mq9" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop session" }));

  expect((await screen.findByRole("alert")).textContent).toContain("This session has already ended.");
});

const ACCOUNTS = { accounts: [{ name: "alice", created_at: now - 30 * 86_400_000 }, { name: "ops", created_at: now - 86_400_000 * 1.5 }] };

test("accounts mark the signed-in one, which cannot delete itself here", async () => {
  renderAdmin("/admin/accounts", signedIn({ "GET accounts": { status: 200, body: ACCOUNTS } }));

  const table = await screen.findByRole("table", { name: "Accounts" });
  await within(table).findByText("you");
  expect(within(table).getByText("30 days ago")).toBeTruthy();
  expect(within(table).getByText("yesterday")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete account alice" })).toBeNull();
  expect(screen.getByRole("button", { name: "Delete account ops" })).toBeTruthy();
});

/** Opens the add dialog and sends bob with a valid password; returns the dialog. */
async function addBob(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Add account" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/account name/i), "bob");
  await user.type(within(dialog).getByLabelText(/^password/i), "a long password here");
  await user.click(within(dialog).getByRole("button", { name: "Add account" }));
  return dialog;
}

test("adding an account posts it and closes the dialog", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin("/admin/accounts", signedIn({ "GET accounts": { status: 200, body: ACCOUNTS }, "POST accounts": { status: 201, body: { name: "bob" } } }));

  await addBob(user);

  await waitFor(() => expect(noOpenDialog("dialog")).toBe(true));
  expect(calls.find((c) => c.method === "POST" && c.path === "accounts")?.body).toEqual({ name: "bob", password: "a long password here" });
});

test("a taken account name is reported in the dialog", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/accounts", signedIn({ "GET accounts": { status: 200, body: ACCOUNTS }, "POST accounts": { status: 409, body: { error: "account exists" } } }));

  const dialog = await addBob(user);

  expect((await within(dialog).findByRole("alert")).textContent).toContain("An account with this name exists.");
});

test("a wrong current password is reported without signing out", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/accounts", signedIn({ "POST me/password": { status: 403, body: { error: "the current password is wrong" } } }));

  await user.type(await screen.findByLabelText(/current password/i), "not my password");
  await user.type(screen.getByLabelText(/new password/i), "a brand new password");
  await user.click(screen.getByRole("button", { name: "Change password" }));

  expect((await screen.findByRole("alert")).textContent).toContain("The current password is wrong.");
  expect(screen.getByRole("heading", { name: "Accounts" })).toBeTruthy();
});
