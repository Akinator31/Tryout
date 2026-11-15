// The settings pages over a fake API: editing the draft, reviewing and
// applying it, a revision published meanwhile, the theme, and the revisions.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { Call } from "./support.tsx";
import { renderAdmin, signedIn } from "./support.tsx";

const DOC = {
  embed_frame_ancestors: ["https://portfolio.example.org"],
  nodes: { local: { agent_url: "https://agent:7000", public_url: "http://localhost:8080/s/{session}/", max_sessions: 10 } },
};

/** The routes of a signed-in admin whose active settings are DOC at revision 15. */
const routes = (extra = {}) => signedIn({ "GET settings": { status: 200, body: { revision: 15, document: DOC } }, ...extra });

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

/** Whether no dialog is open; jsdom never ends the exit animation, so a closed one may stay mounted. */
const noOpenDialog = () => screen.queryAllByRole("dialog", { hidden: true }).every((d) => d.getAttribute("data-state") === "closed");

test("adding an origin explains a missing scheme, then joins the draft and is applied after review", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin(
    "/admin/embedding",
    routes({
      "POST config/validate": { status: 200, body: { warnings: [] } },
      "POST revisions": { status: 201, body: { revision: { id: 16 }, warnings: [] } },
    }),
  );

  const input = await screen.findByRole("textbox", { name: "New origin" });
  await user.type(input, "app.example.org");
  await user.click(screen.getByRole("button", { name: "Add origin" }));
  expect(screen.getByText("Add the scheme: https://app.example.org")).toBeTruthy();

  await user.clear(input);
  await user.type(input, "https://app.example.org{Enter}");
  expect(screen.getByText("https://app.example.org")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Review 1 change" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Review and apply revision 16")).toBeTruthy();
  expect(within(dialog).getByText("+ embed_frame_ancestors https://app.example.org")).toBeTruthy();
  expect(await within(dialog).findByText("Schema and settings valid")).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Apply revision 16" }));

  await waitFor(() => expect(noOpenDialog()).toBe(true));
  const [publication] = posted(calls, "revisions");
  expect(publication.body).toEqual({
    base: 15,
    document: { ...DOC, embed_frame_ancestors: ["https://portfolio.example.org", "https://app.example.org"] },
    note: "+ embed_frame_ancestors https://app.example.org",
  });
  expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
});

test("settings the server refuses block Apply and show its problems", async () => {
  const user = userEvent.setup();
  renderAdmin(
    "/admin/embedding",
    routes({ "POST config/validate": { status: 422, body: { error: "invalid settings", problems: ["limits.streams_per_ip: must be >= 0"] } } }),
  );

  const streams = await screen.findByRole("textbox", { name: "Event streams per IP" });
  await user.clear(streams);
  await user.type(streams, "3");
  await user.click(screen.getByRole("button", { name: "Review 1 change" }));

  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("limits.streams_per_ip: must be >= 0")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "Apply revision 16" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a field that does not parse says why and leaves the draft alone", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/embedding", routes());

  const window = await screen.findByRole("textbox", { name: "Window" });
  await user.clear(window);
  await user.type(window, "soon");

  expect(screen.getByText("A duration such as 30s or 1m.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
});

test("a revision published meanwhile moves the draft on top of it before applying again", async () => {
  const user = userEvent.setup();
  let revision = 15;
  const newer = { ...DOC, embed_frame_ancestors: [...DOC.embed_frame_ancestors, "https://other.org"] };

  const { calls } = renderAdmin(
    "/admin/embedding",
    signedIn({
      "GET settings": () => ({ status: 200, body: { revision, document: revision === 15 ? DOC : newer } }),
      "POST config/validate": { status: 200, body: { warnings: [] } },
      "POST revisions": (call) => {
        if ((call.body as { base: number }).base === 15) {
          revision = 16;
          return { status: 409, body: { error: "revision 16 was published meanwhile", latest: 16 } };
        }
        return { status: 201, body: { revision: { id: 17 }, warnings: [] } };
      },
    }),
  );

  await user.type(await screen.findByRole("textbox", { name: "New origin" }), "https://app.example.org{Enter}");
  await user.click(screen.getByRole("button", { name: "Review 1 change" }));
  await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Apply revision 16" }));

  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText(/A newer revision was published meanwhile/)).toBeTruthy();
  expect(await within(dialog).findByText("Review and apply revision 17")).toBeTruthy();
  expect(screen.getByText(/Revision 16 was published while you edited revision 15/)).toBeTruthy();

  await user.click(await within(dialog).findByRole("button", { name: "Apply revision 17" }));
  await waitFor(() => expect(posted(calls, "revisions")).toHaveLength(2));
  expect(posted(calls, "revisions")[1].body).toMatchObject({
    base: 16,
    document: { embed_frame_ancestors: ["https://portfolio.example.org", "https://other.org", "https://app.example.org"] },
  });
});

test("the theme checks the accent's contrast and goes back to the default", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/theme", routes({ "GET settings": { status: 200, body: { revision: 15, document: { ...DOC, theme: { accent: "#4CBDFF" } } } } }));

  const accent = await screen.findByRole("textbox", { name: "theme.accent" });
  expect(screen.getByText(/^8\.8:1 on the card/)).toBeTruthy();

  await user.clear(accent);
  await user.type(accent, "#333333");
  expect(screen.getByText(/^1\.5:1 on the card/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review 1 change" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Use the default (#FFB000)" }));
  expect((accent as HTMLInputElement).value).toBe("#FFB000");
  expect(screen.getByRole("button", { name: "Review 1 change" })).toBeTruthy();
});

const now = Date.now();
const REVISIONS = [
  { id: 3, parent: 2, author: "alice", note: "Add origin", createdAt: now - 86_400_000 * 2 },
  { id: 2, parent: 1, author: "ops", note: null, createdAt: now - 86_400_000 * 5 },
  { id: 1, parent: null, author: "file import", note: "Imported from tryout.yaml", createdAt: now - 86_400_000 * 30 },
];

/** The routes of three revisions; 2 changed a node's cap. */
const revisionRoutes = (extra = {}) =>
  routes({
    "GET revisions": { status: 200, body: { revisions: REVISIONS } },
    "GET revisions/1": { status: 200, body: { ...REVISIONS[2], document: DOC } },
    "GET revisions/2": { status: 200, body: { ...REVISIONS[1], document: { ...DOC, nodes: { local: { ...DOC.nodes.local, max_sessions: 4 } } } } },
    ...extra,
  });

test("a revision shows its changes from its parent and rolls back on top of the newest", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin("/admin/revisions/2", revisionRoutes({ "POST revisions/2/rollback": { status: 201, body: { revision: { id: 4 }, warnings: [] } } }));

  expect(await screen.findByText("Revision 3 is active, published by alice 2 days ago.")).toBeTruthy();
  const changes = await screen.findByRole("region", { name: "settings" });
  expect(within(changes).getByText("max_sessions: 10")).toBeTruthy();
  expect(within(changes).getByText("max_sessions: 4")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Roll back to revision 2" }));
  await waitFor(() => expect(posted(calls, "revisions/2/rollback")).toHaveLength(1));
  expect(posted(calls, "revisions/2/rollback")[0].body).toEqual({ base: 3 });
});

test("a rollback refused because sessions run on a node names the node", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/revisions/2", revisionRoutes({ "POST revisions/2/rollback": { status: 409, body: { error: "node in use", nodes: ["pi5"] } } }));

  await user.click(await screen.findByRole("button", { name: "Roll back to revision 2" }));
  expect(await screen.findByText("Sessions run on pi5: the node cannot be removed or moved now.")).toBeTruthy();
});

test("rolling back waits until the pending changes are applied or discarded", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/embedding", revisionRoutes());

  await user.type(await screen.findByRole("textbox", { name: "New origin" }), "https://app.example.org{Enter}");
  await user.click(screen.getByRole("link", { name: "Revisions" }));
  await user.click(await screen.findByRole("button", { name: "Show revision 2" }));

  expect(await screen.findByText("Apply or discard your pending changes first.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Roll back to revision 2" }) as HTMLButtonElement).disabled).toBe(true);
});
