import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

// A fixed installation id so the test fully controls the device identity.
// The app stores this under `nexus.installationId.v1` in localStorage.
const DEVICE_ID = "e2e-workspace-session-restore-device";
const INSTALLATION_ID_STORAGE_KEY = "nexus.installationId.v1";
const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

interface WorkspacePaneStateV4 {
  id: string;
  href: string;
  widthPx: number;
  visibility: "visible" | "minimized";
}

interface WorkspaceStateV4 {
  schemaVersion: 4;
  activePaneId: string;
  panes: WorkspacePaneStateV4[];
}

interface WorkspaceSessionEntry {
  state: WorkspaceStateV4;
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
function twoPaneSession(): WorkspaceStateV4 {
  return {
    schemaVersion: 4,
    activePaneId: "pane-session-libraries",
    panes: [
      {
        id: "pane-session-libraries",
        href: "/libraries",
        widthPx: 480,
        visibility: "visible",
      },
      {
        id: "pane-session-notes",
        href: "/notes",
        widthPx: 520,
        visibility: "visible",
      },
    ],
  };
}

// A distinct two-pane session whose second pane differs from `twoPaneSession`.
// Seeding this lets a test prove the deep-link URL — not the saved session —
// drove what rendered.
function conversationsPaneSession(): WorkspaceStateV4 {
  return {
    schemaVersion: 4,
    activePaneId: "pane-session-libraries",
    panes: [
      {
        id: "pane-session-libraries",
        href: "/libraries",
        widthPx: 480,
        visibility: "visible",
      },
      {
        id: "pane-session-conversations",
        href: "/conversations",
        widthPx: 520,
        visibility: "visible",
      },
    ],
  };
}

// A trivial single default pane — `isNonTrivialSession` treats this as nothing
// worth restoring, so it is the right value to reset to during cleanup.
function trivialSession(): WorkspaceStateV4 {
  return {
    schemaVersion: 4,
    activePaneId: "pane-session-default",
    panes: [
      {
        id: "pane-session-default",
        href: "/libraries",
        widthPx: 480,
        visibility: "visible",
      },
    ],
  };
}

function encodeWorkspaceStateParam(value: WorkspaceStateV4): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Pin the device id before any navigation so capture + restore key off the
// id the test controls.
async function pinDeviceId(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      try {
        localStorage.setItem(key, id);
      } catch {
        /* private mode / quota — ignored */
      }
    },
    [INSTALLATION_ID_STORAGE_KEY, DEVICE_ID]
  );
}

async function putWorkspaceSession(
  request: APIRequestContext,
  state: WorkspaceStateV4
): Promise<void> {
  const response = await request.put(WORKSPACE_SESSION_PATH, {
    data: { device_id: DEVICE_ID, state },
  });
  expect(response.ok()).toBeTruthy();
}

async function fetchWorkspaceSession(
  request: APIRequestContext
): Promise<WorkspaceSessionResponse["data"]> {
  const response = await request.get(
    `${WORKSPACE_SESSION_PATH}?device_id=${encodeURIComponent(DEVICE_ID)}`
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as WorkspaceSessionResponse;
  return payload.data;
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("workspace session restore", () => {
  test("cold open silently restores a saved session", async ({ page }) => {
    await pinDeviceId(page);
    await putWorkspaceSession(page.request, twoPaneSession());

    try {
      // Cold open: a base URL with no `ws=` param.
      await page.goto("/libraries");

      // The saved two-pane workspace is restored silently — no banner, no
      // clicks. Both panes appear once the fetch + restore resolves.
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible({
        timeout: 15_000,
      });

      // Applying the restored state writes it into the URL as a `ws=` param.
      await expect(page).toHaveURL(/[?&]ws=/);
    } finally {
      await putWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a workspace change is captured to the saved session", async ({ page }) => {
    await pinDeviceId(page);
    // Start from a trivial session so the cold open arms capture without
    // restoring anything.
    await putWorkspaceSession(page.request, trivialSession());

    try {
      await page.goto("/libraries");
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();

      // Open a second pane: shift-click an in-pane library link.
      const libraryLink = page.locator("a[href^='/libraries/']").first();
      await expect(libraryLink).toBeVisible();
      await libraryLink.click({ modifiers: ["Shift"] });

      // The workspace now shows two panes — one "Close <title>" button each.
      await expect(
        page
          .getByRole("toolbar", { name: "Workspace panes" })
          .getByRole("button", { name: /^Close / })
      ).toHaveCount(2);

      // Wait out the ~1s debounce, then assert the captured session grew.
      await expect
        .poll(
          async () => (await fetchWorkspaceSession(page.request)).own?.state.panes.length ?? 0,
          { timeout: 15_000 }
        )
        .toBeGreaterThan(1);
    } finally {
      await putWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a ws= URL is authoritative and silent restore does not override it", async ({
    page,
  }) => {
    await pinDeviceId(page);
    // Seed a saved session that is DISTINCT from the deep link below: silent
    // restore, if it ran, would surface a "Notes" pane.
    await putWorkspaceSession(page.request, twoPaneSession());

    try {
      // The deep link carries its own panes (Libraries + Conversations).
      const deepLinkState = encodeWorkspaceStateParam(conversationsPaneSession());
      await page.goto(`/libraries?wsv=4&ws=${deepLinkState}`);

      // The URL is authoritative: its panes render and silent restore stays
      // out of the way — the saved session's "Notes" pane never appears.
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
      await expect(workspacePaneButton(page, /^Conversations\b/)).toBeVisible();
      await expect(workspacePaneButton(page, /^Notes\b/)).toHaveCount(0);
    } finally {
      await putWorkspaceSession(page.request, trivialSession());
    }
  });
});
