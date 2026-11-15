// The projects and nodes pages over a fake API: the list, creating a project,
// pausing and removing one, and adding a node after testing its connection.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { Call } from "./support.tsx";
import { renderAdmin, signedIn } from "./support.tsx";

const LOCAL = { agent_url: "https://agent:7000", public_url: "http://localhost:8080/s/{session}/", max_sessions: 4 };
const CLI = { node: "local", image: "tryout-example/cli-hello:dev", kind: "terminal", port: 7681, max_sessions: 2, max_age: "10m" };
const DOC = { embed_frame_ancestors: ["https://portfolio.example.org"], nodes: { local: LOCAL }, projects: { "cli-hello": CLI } };

const NODES = [{ name: "local", up: true, checked_at: Date.now(), agent: { version: "0.2.0", profile: "dev", default_runtime: "runc" }, tickets: { waiting: 0, starting: 0, active: 1 } }];
const SESSIONS = [{ ticket: "7k2mq9aaaa", project: "cli-hello", node: "local", state: "active", created_at: Date.now() - 60_000, started_at: Date.now() - 60_000, ends_at: Date.now() + 300_000 }];

/** The routes of a signed-in admin whose active settings are `document` at revision 15. */
const routes = (document: object = DOC, extra = {}) =>
  signedIn({
    "GET settings": { status: 200, body: { revision: 15, document } },
    "GET nodes": { status: 200, body: { nodes: NODES } },
    "GET sessions": { status: 200, body: { sessions: SESSIONS } },
    "POST config/validate": { status: 200, body: { warnings: [] } },
    "POST revisions": { status: 201, body: { revision: { id: 16 }, warnings: [] } },
    ...extra,
  });

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

test("the projects list shows each project's load and state, and opens it", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects", routes());

  expect(await screen.findByText("1 session live out of 2 slots.")).toBeTruthy();
  const row = screen.getByRole("link", { name: "Open project cli-hello" }).closest("tr")!;
  expect(within(row).getByText("1 / 2")).toBeTruthy();
  expect(within(row).getByText("Running")).toBeTruthy();

  await user.click(screen.getByRole("link", { name: "Open project cli-hello" }));
  expect(await screen.findByRole("heading", { name: "cli-hello" })).toBeTruthy();
  expect(screen.getByText("7k2mq9")).toBeTruthy();
});

test("without projects, the first steps say what is done", async () => {
  renderAdmin("/admin/projects", routes({ nodes: { local: LOCAL } }));

  expect(await screen.findByText("Add your first project")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "New project" }).length).toBeGreaterThan(0);
});

test("a new project is checked as typed, then put in the draft and reviewed", async () => {
  const user = userEvent.setup();
  let published: object | null = null;
  const { calls } = renderAdmin(
    "/admin/projects/new",
    routes(DOC, {
      "GET settings": () => ({ status: 200, body: published ? { revision: 16, document: published } : { revision: 15, document: DOC } }),
      "POST revisions": (call: Call) => {
        published = (call.body as { document: object }).document;
        return { status: 201, body: { revision: { id: 16 }, warnings: [] } };
      },
    }),
  );

  const name = await screen.findByRole("textbox", { name: /Project name/ });
  await user.type(name, "my_CLI");
  expect(screen.getByText("Lower-case letters, digits and -, starting with a letter or digit.")).toBeTruthy();

  await user.clear(name);
  await user.type(name, "my-cli");
  await user.type(screen.getByRole("textbox", { name: /^Image/ }), "ghcr.io/me/my-cli:1");
  await user.click(screen.getByRole("button", { name: "Add variable" }));
  await user.type(screen.getByRole("textbox", { name: "Variable 1 name" }), "GREETING");
  await user.type(screen.getByRole("textbox", { name: "Variable 1 value" }), "hello");
  expect(screen.getByText("Fields valid")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Create project" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("+ my-cli (new project)")).toBeTruthy();
  await within(dialog).findByText("Schema and settings valid");
  await user.click(within(dialog).getByRole("button", { name: "Apply revision 16" }));

  await waitFor(() => expect(posted(calls, "revisions")).toHaveLength(1));
  expect(posted(calls, "revisions")[0].body).toMatchObject({
    base: 15,
    document: {
      projects: {
        "cli-hello": CLI,
        "my-cli": { node: "local", image: "ghcr.io/me/my-cli:1", kind: "terminal", port: 7681, max_sessions: 1, max_age: "15m", env: { GREETING: "hello" } },
      },
    },
  });
  expect(await screen.findByRole("heading", { name: "my-cli" })).toBeTruthy();
});

test("creating with problems lists them all and keeps the draft untouched", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/new", routes());

  await user.click(await screen.findByRole("button", { name: "Create project" }));
  expect(screen.getByText("2 problems to fix")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
});

test("pausing a project changes the draft and opens the review", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/cli-hello", routes());

  await user.click(await screen.findByRole("button", { name: "Pause project" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("+ cli-hello.enabled = false")).toBeTruthy();
});

test("removing a project goes back to the list and reviews the removal", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/cli-hello", routes());

  await user.click(await screen.findByRole("button", { name: "Remove cli-hello" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("− cli-hello (project removed)")).toBeTruthy();
  expect(screen.getByText("Add your first project")).toBeTruthy();
});

test("a node runs its projects and cannot be removed while they use it", async () => {
  renderAdmin("/admin/nodes", routes());

  const card = await screen.findByRole("region", { name: "local" });
  expect(within(card).getByText("Healthy")).toBeTruthy();
  expect(within(card).getByText("Agent 0.2.0, profile dev, runtime runc. 1 of 4 sessions.")).toBeTruthy();
  expect(within(card).getByText("Runs cli-hello.")).toBeTruthy();
  expect((within(card).getByRole("button", { name: "Remove node local" }) as HTMLButtonElement).disabled).toBe(true);
});

test("adding a node tests its connection through the dry run, then reviews it", async () => {
  const user = userEvent.setup();
  const { calls } = renderAdmin(
    "/admin/nodes",
    routes(DOC, { "POST config/validate": { status: 200, body: { warnings: ["node pi5: the agent does not answer: no answer within 3 s"] } } }),
  );

  await user.click(await screen.findByRole("button", { name: "Add node" }));
  const drawer = await screen.findByRole("dialog");
  await user.type(within(drawer).getByRole("textbox", { name: /^Name/ }), "pi5");
  await user.type(within(drawer).getByRole("textbox", { name: /Agent URL/ }), "https://10.0.50.10:7000");
  await user.type(within(drawer).getByRole("textbox", { name: /Public URL/ }), "https://sbx.example.dev/s/{{session}/");

  await user.click(within(drawer).getByRole("button", { name: "Test connection" }));
  expect(await within(drawer).findByText("no answer within 3 s")).toBeTruthy();
  expect(posted(calls, "config/validate")[0].body).toMatchObject({ document: { nodes: { local: LOCAL, pi5: { agent_url: "https://10.0.50.10:7000", max_sessions: 4 } } } });

  await user.click(within(drawer).getByRole("button", { name: "Add node" }));
  const review = await screen.findByText("Review and apply revision 16");
  expect(within(review.closest("[role=dialog]") as HTMLElement).getByText("+ pi5 (new node)")).toBeTruthy();
});

test("saving an edit that changes nothing goes back to the project without a review", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/cli-hello/edit", routes());

  await user.click(await screen.findByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("heading", { name: "cli-hello" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a pause still in the draft leaves the project's state as visitors see it", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/cli-hello", routes());

  await user.click(await screen.findByRole("button", { name: "Pause project" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep editing" }));

  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(screen.getByText("Running")).toBeTruthy();
  expect(screen.queryByText("New visitors see “unavailable”. Sessions running now and visitors already in line carry on.")).toBeNull();
});

const ME = { name: "alice", version: "0.2.0", public_url: "https://tryout.example.org", preview: true };

test("the preview runs the embed page in a frame on click, once the embed page allows the admin", async () => {
  const user = userEvent.setup();
  const allowed = { ...DOC, embed_frame_ancestors: [...DOC.embed_frame_ancestors, window.location.origin] };
  renderAdmin("/admin/projects/cli-hello", routes(allowed, { "GET me": { status: 200, body: ME } }));

  const card = await screen.findByRole("region", { name: "Preview" });
  expect(within(card).getByText("Runs /embed/cli-hello here. It goes through the queue and takes one of the 2 slots until you stop it.")).toBeTruthy();
  expect(card.querySelector("iframe")).toBeNull();

  await user.click(within(card).getByRole("button", { name: "Start preview" }));
  const frame = within(card).getByTitle("Preview of cli-hello");
  expect(frame.getAttribute("src")).toBe("https://tryout.example.org/embed/cli-hello");
  expect(frame.getAttribute("allow")).toContain("fullscreen");

  await user.click(within(card).getByRole("button", { name: "Stop preview" }));
  expect(card.querySelector("iframe")).toBeNull();
});

test("the preview says why it cannot start", async () => {
  renderAdmin("/admin/projects/cli-hello", routes(DOC, { "GET me": { status: 200, body: ME } }));

  const card = await screen.findByRole("region", { name: "Preview" });
  expect(within(card).getByText(`The embed page refuses this admin as a parent. Add ${window.location.origin} to the allowed origins.`)).toBeTruthy();
  expect((within(card).getByRole("button", { name: "Start preview" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(card).getByRole("link", { name: "Open Embedding" })).toBeTruthy();
});

test("the embed card gives the address, the allowed parents and the snippet", async () => {
  const user = userEvent.setup();
  renderAdmin("/admin/projects/cli-hello", routes(DOC, { "GET me": { status: 200, body: ME } }));

  const card = await screen.findByRole("region", { name: "Embed" });
  expect(within(card).getByText("https://tryout.example.org/embed/cli-hello")).toBeTruthy();
  expect(within(card).getByText("'self'")).toBeTruthy();
  expect(within(card).getByText("https://portfolio.example.org")).toBeTruthy();

  await user.click(within(card).getByRole("button", { name: "Copy iframe snippet" }));
  expect(await navigator.clipboard.readText()).toMatch(/^<iframe src="https:\/\/tryout\.example\.org\/embed\/cli-hello"/);
  expect(within(card).getByRole("button", { name: "Copied" })).toBeTruthy();
});

test("without public_url, the embed card shows the path and the preview asks for it", async () => {
  renderAdmin("/admin/projects/cli-hello", routes());

  const embed = await screen.findByRole("region", { name: "Embed" });
  expect(within(embed).getByText("/embed/cli-hello")).toBeTruthy();
  expect(within(embed).getByText("Set public_url in tryout.yaml for the full address.")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Preview" })).getByText("Set public_url in tryout.yaml to preview here.")).toBeTruthy();
});
