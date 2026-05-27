import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  WORKSPACE_E2E_SCHEMA_VERSION,
  encodeWorkspaceStateParam,
  makeWorkspacePane,
  type WorkspaceState,
} from "./workspace";

// A fixed installation id so the test fully controls the device identity.
// The app stores this under `nexus.installationId.v1` in localStorage.
const DEVICE_ID = "e2e-workspace-session-restore-device";
const INSTALLATION_ID_STORAGE_KEY = "nexus.installationId.v1";
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
  return {
    schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
    activePaneId: "pane-session-libraries",
    panes: [
      makeWorkspacePane("pane-session-libraries", "/libraries", { widthPx: 480 }),
      makeWorkspacePane("pane-session-notes", "/notes", { widthPx: 520 }),
    ],
  };
}

// A distinct two-pane session whose second pane differs from `twoPaneSession`.
// Seeding this lets a test prove the deep-link URL — not the saved session —
// drove what rendered.
function conversationsPaneSession(): WorkspaceState {
  return {
    schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
    activePaneId: "pane-session-libraries",
    panes: [
      makeWorkspacePane("pane-session-libraries", "/libraries", { widthPx: 480 }),
      makeWorkspacePane("pane-session-conversations", "/conversations", {
        widthPx: 520,
      }),
    ],
  };
}

// A trivial single default pane — `isNonTrivialSession` treats this as nothing
// worth restoring, so it is the right value to reset to during cleanup.
function trivialSession(): WorkspaceState {
  return {
    schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
    activePaneId: "pane-session-default",
    panes: [makeWorkspacePane("pane-session-default", "/libraries", { widthPx: 480 })],
  };
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
  state: WorkspaceState
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
      await page.goto(`/libraries?wsv=${WORKSPACE_E2E_SCHEMA_VERSION}&ws=${deepLinkState}`);

      // The URL is authoritative: its panes render and silent restore stays
      // out of the way — the saved session's "Notes" pane never appears.
      await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
      await expect(workspacePaneButton(page, /^Conversations\b/)).toBeVisible();
      await expect(workspacePaneButton(page, /^Notes\b/)).toHaveCount(0);
    } finally {
      await putWorkspaceSession(page.request, trivialSession());
    }
  });

  test("a direct URL without ws is active and preserves the saved workspace", async ({
    page,
  }) => {
    await pinDeviceId(page);
    // A direct app URL is still user intent, even without an encoded workspace
    // state. Restore may preserve saved panes, but it must not replace the
    // requested route with the saved active pane.
    await putWorkspaceSession(page.request, twoPaneSession());

    try {
      await page.goto("/conversations");

      await expect(workspacePaneButton(page, /^Chats\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(workspacePaneButton(page, /^Chats\b/)).toHaveAttribute(
        "aria-current",
        "page",
      );
    } finally {
      await putWorkspaceSession(page.request, trivialSession());
    }
  });
});
