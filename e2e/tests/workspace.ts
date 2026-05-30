import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";

type WorkspacePaneVisibility = "visible" | "minimized";

// The app stores the device id under this key in localStorage. Pinning it lets
// a test key its server-session capture + restore to an id it controls.
export const INSTALLATION_ID_STORAGE_KEY = "nexus.installationId.v1";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";

export interface WorkspacePaneHistory {
  back: string[];
  forward: string[];
}

export interface WorkspacePaneState {
  id: string;
  href: string;
  primaryWidthPx: number;
  visibility: WorkspacePaneVisibility;
  history: WorkspacePaneHistory;
  attachedSecondaryPaneId: string | null;
}

export interface WorkspaceAttachedSecondaryPaneState {
  id: string;
  parentPrimaryPaneId: string;
  groupId: "reader-tools" | "conversation-context" | "library-tools";
  activeSurfaceId:
    | "reader-highlights"
    | "reader-doc-chat"
    | "conversation-references"
    | "conversation-forks"
    | "library-chat"
    | "library-intelligence";
  widthPx: number;
  visibility: "visible" | "collapsed";
}

export interface WorkspaceState {
  activePrimaryPaneId: string;
  primaryPaneOrder: string[];
  primaryPanesById: Record<string, WorkspacePaneState>;
  secondaryPanesById: Record<string, WorkspaceAttachedSecondaryPaneState>;
}

export function makeWorkspacePane(
  id: string,
  href: string,
  options?: {
    primaryWidthPx?: number;
    visibility?: WorkspacePaneVisibility;
    history?: WorkspacePaneHistory;
  },
): WorkspacePaneState {
  return {
    id,
    href,
    primaryWidthPx: options?.primaryWidthPx ?? 560,
    visibility: options?.visibility ?? "visible",
    history: options?.history ?? { back: [], forward: [] },
    attachedSecondaryPaneId: null,
  };
}

export function makeWorkspaceState(
  primaryPanes: WorkspacePaneState[],
  options?: {
    activePrimaryPaneId?: string;
    secondaryPanesById?: Record<string, WorkspaceAttachedSecondaryPaneState>;
  },
): WorkspaceState {
  return {
    activePrimaryPaneId: options?.activePrimaryPaneId ?? primaryPanes[0]!.id,
    primaryPaneOrder: primaryPanes.map((pane) => pane.id),
    primaryPanesById: Object.fromEntries(
      primaryPanes.map((pane) => [pane.id, pane]),
    ),
    secondaryPanesById: options?.secondaryPanesById ?? {},
  };
}

export function singlePaneWorkspaceState(
  href: string,
  options?: { paneId?: string; primaryWidthPx?: number; history?: WorkspacePaneHistory },
): WorkspaceState {
  const paneId = options?.paneId ?? "pane-e2e-primary";
  return makeWorkspaceState(
    [
      makeWorkspacePane(paneId, href, {
        primaryWidthPx: options?.primaryWidthPx ?? 684,
        history: options?.history,
      }),
    ],
    { activePrimaryPaneId: paneId },
  );
}

// Pin the device id before any navigation so capture + restore key off the id
// the test controls. Runs as an init script, i.e. before any page load.
export async function pinDeviceId(page: Page, deviceId: string): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      try {
        localStorage.setItem(key, id);
      } catch {
        /* private mode / quota — ignored */
      }
    },
    [INSTALLATION_ID_STORAGE_KEY, deviceId],
  );
}

// Seed the server session store for a device. This is the canonical multi-pane
// setup now that layout never travels in the URL.
export async function seedWorkspaceSession(
  request: APIRequestContext,
  deviceId: string,
  state: WorkspaceState,
): Promise<void> {
  const response = await request.put(WORKSPACE_SESSION_PATH, {
    headers: stateChangingApiHeaders(),
    data: { device_id: deviceId, state },
  });
  expect(response.ok()).toBeTruthy();
}

// Pin the device, seed its session, then open `path`. The canonical way to
// stage a multi-pane workspace for a test now that layout lives only in the
// server session store.
export async function gotoWithWorkspaceSession(
  page: Page,
  deviceId: string,
  state: WorkspaceState,
  path: string,
): Promise<void> {
  await pinDeviceId(page, deviceId);
  await seedWorkspaceSession(page.request, deviceId, state);
  await page.goto(path);
}

export function activeWorkspacePane(page: Page): Locator {
  return page.locator('[data-pane-id][data-active="true"]').first();
}

export function workspacePaneButton(page: Page, name: RegExp | string): Locator {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

export async function gotoSinglePaneWorkspace(
  page: Page,
  deviceId: string,
  href: string,
  options?: { paneId?: string; primaryWidthPx?: number; history?: WorkspacePaneHistory },
): Promise<void> {
  await gotoWithWorkspaceSession(page, deviceId, singlePaneWorkspaceState(href, options), href);
  await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
}
