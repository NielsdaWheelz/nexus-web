import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
import { AUTHENTICATED_HOME_PATH } from "./app-routes";
import {
  activeWorkspacePane,
  makeWorkspacePane,
  makeWorkspaceState,
  pinDeviceId,
  seedWorkspaceSession,
  workspacePaneButton,
  type WorkspaceState,
} from "./workspace";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

interface WorkspaceSessionEntry {
  state: WorkspaceState;
  updated_at: string;
}

interface WorkspaceSessionResponse {
  data: {
    device_id: string;
    own: WorkspaceSessionEntry | null;
    most_recent_elsewhere: WorkspaceSessionEntry | null;
  };
}

// A non-trivial two-pane session: more than one pane makes it worth restoring.
function twoPaneSession(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-session-libraries", "/libraries", { primaryWidthPx: 480 }),
      makeWorkspacePane("pane-session-notes", "/notes", { primaryWidthPx: 520 }),
    ],
    { activePrimaryPaneId: "pane-session-libraries" },
  );
}

// A trivial single default pane — `isNonTrivialSession` treats this as nothing
// worth restoring, so it is the right value to reset to during cleanup.
function trivialSession(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-session-default", AUTHENTICATED_HOME_PATH, {
        primaryWidthPx: 480,
      }),
    ],
    { activePrimaryPaneId: "pane-session-default" },
  );
}

function workspaceSessionRestoreDeviceId(testInfo: TestInfo): string {
  const slug = testInfo.titlePath
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `e2e-workspace-session-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${slug}`;
}

async function fetchWorkspaceSession(
  request: APIRequestContext,
): Promise<WorkspaceSessionResponse["data"]> {
  const response = await request.get(WORKSPACE_SESSION_PATH);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as WorkspaceSessionResponse;
  return payload.data;
}

// Create a conversation that is NOT part of any seeded session, so a deep link
// to it exercises the merge-an-absent-resource path.
async function createConversation(page: Page): Promise<string> {
  if (page.url() === "about:blank") {
    await page.goto("/libraries");
  }
  await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
    timeout: 15_000,
  });
  const response = await page.request.post("/api/conversations", {
    headers: stateChangingApiHeaders(),
    maxRedirects: 0,
  });
  const status = response.status();
  const body = await response.text();
  expect(
    status < 300 || status >= 400,
    `POST /api/conversations redirected unexpectedly: status=${status}; location=${response.headers()["location"] ?? "<none>"}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();
  expect(
    response.ok(),
    `POST /api/conversations failed: status=${status}; contentType=${response.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}`,
  ).toBeTruthy();
  let payload: { data: { id: string } };
  try {
    payload = JSON.parse(body) as { data: { id: string } };
  } catch (error) {
    throw new Error(
      `POST /api/conversations returned non-JSON response: contentType=${response.headers()["content-type"] ?? "<none>"}; body=${body.slice(0, 400)}; parseError=${String(error)}`,
    );
  }
  return payload.data.id;
}

function activeWorkspacePaneButton(page: Page) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .locator('button[aria-current="page"]')
    .first();
}

test.describe("workspace session restore", () => {
  test("cold open silently restores a saved session", async ({ page }, testInfo) => {
    const deviceId = workspaceSessionRestoreDeviceId(testInfo);
    await pinDeviceId(page, deviceId);
    await seedWorkspaceSession(page.request, twoPaneSession());

    try {
      // Cold open the active pane's own route; siblings hydrate from the session.
      await page.goto("/libraries");

      // The saved two-pane workspace is restored silently — no banner, no
      // clicks. Both panes appear once the fetch + restore resolves.
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible({
        timeout: 15_000,
      });

      // Layout never travels in the URL: the address bar is just the active
      // pane's path, with no encoded-state query param.
      await expect(page).toHaveURL(/\/libraries$/);
    } finally {
      await seedWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a workspace change is captured to the saved session", async ({ page }, testInfo) => {
    const deviceId = workspaceSessionRestoreDeviceId(testInfo);
    await pinDeviceId(page, deviceId);
    // Start from a trivial session so the cold open arms capture without
    // restoring anything.
    await seedWorkspaceSession(page.request, trivialSession());

    try {
      await page.goto("/libraries");
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });

      // Open a second pane: shift-click an in-pane library link.
      // Scope to the active pane so the click lands inside PaneRouteBoundary
      // and the pane runtime is guaranteed to be mounted.
      const libraryLink = activeWorkspacePane(page)
        .locator("a[href^='/libraries/']")
        .first();
      await expect(libraryLink).toBeVisible({ timeout: 10_000 });
      await libraryLink.click({ modifiers: ["Shift"] });

      await expect
        .poll(
          () =>
            page
              .getByRole("toolbar", { name: "Workspace panes" })
              .getByRole("button", { name: /^Close / })
              .count(),
          { timeout: 10_000 },
        )
        .toBeGreaterThan(1);

      // Wait out the ~1s debounce, then assert the captured session grew.
      await expect
        .poll(
          async () =>
            (await fetchWorkspaceSession(page.request)).own?.state
              .primaryPaneOrder.length ?? 0,
          { timeout: 15_000 }
        )
        .toBeGreaterThan(1);
    } finally {
      await seedWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a deep link to a resource absent from the session appends it as the active pane", async ({
    page,
  }, testInfo) => {
    const deviceId = workspaceSessionRestoreDeviceId(testInfo);
    await pinDeviceId(page, deviceId);
    // Seed a two-pane session (Libraries + Notes) that does NOT contain the
    // conversation we are about to deep-link to.
    await seedWorkspaceSession(page.request, twoPaneSession());

    try {
      const conversationId = await createConversation(page);
      await page.goto(`/conversations/${conversationId}`);

      // The restored layout is preserved — both saved panes still appear — and
      // the deep-linked conversation is added as a third, active pane.
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page
          .getByRole("toolbar", { name: "Workspace panes" })
          .getByRole("button", { name: /^Close / })
      ).toHaveCount(3);

      // The deep-linked pane is the active one, and the address bar is just its
      // path — no encoded-state param ever.
      await expect(activeWorkspacePaneButton(page)).toBeVisible();
      await expect(page).toHaveURL(
        new RegExp(`/conversations/${conversationId}$`)
      );
    } finally {
      await seedWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a deep link to a resource already in the session focuses its existing pane", async ({
    page,
  }, testInfo) => {
    const deviceId = workspaceSessionRestoreDeviceId(testInfo);
    await pinDeviceId(page, deviceId);
    // Seed a two-pane session whose first pane is the active one (Libraries).
    await seedWorkspaceSession(page.request, twoPaneSession());

    try {
      // Deep-link to /notes, which IS already a pane in the saved session.
      await page.goto("/notes");

      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible({
        timeout: 15_000,
      });

      // No duplicate pane is added — still exactly two panes — and the existing
      // Notes pane becomes active.
      await expect(
        page
          .getByRole("toolbar", { name: "Workspace panes" })
          .getByRole("button", { name: /^Close / })
      ).toHaveCount(2);
      await expect(workspacePaneButton(page, /^Notes\b/)).toHaveAttribute(
        "aria-current",
        "page",
        { timeout: 15_000 }
      );
      await expect(page).toHaveURL(/\/notes$/);
    } finally {
      await seedWorkspaceSession(page.request, trivialSession());
    }
  });
});
