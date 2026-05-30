import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { stateChangingApiHeaders } from "./api";

type WorkspacePaneVisibility = "visible" | "minimized";

// The app stores the device id under this key in localStorage. Pinning it lets
// a test key its server-session capture + restore to an id it controls.
export const INSTALLATION_ID_STORAGE_KEY = "nexus.installationId.v1";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";
const DEVICE_ID_WINDOW_NAME_PREFIX = "nexus:e2e:workspace-device:";
export const ACTIVE_WORKSPACE_PANE_SELECTOR = '[data-pane-id][data-active="true"]';

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
    ([key, prefix]) => {
      try {
        if (window.name.startsWith(prefix)) {
          localStorage.setItem(key, window.name.slice(prefix.length));
        }
      } catch {
        /* private mode / quota - ignored */
      }
    },
    [INSTALLATION_ID_STORAGE_KEY, DEVICE_ID_WINDOW_NAME_PREFIX],
  );
  try {
    await page.evaluate(
      ([key, id, prefix]) => {
        window.name = `${prefix}${id}`;
        try {
          localStorage.setItem(key, id);
        } catch {
          /* private mode / quota - ignored */
        }
      },
      [INSTALLATION_ID_STORAGE_KEY, deviceId, DEVICE_ID_WINDOW_NAME_PREFIX],
    );
  } catch {
    // about:blank and early cross-origin documents may not expose localStorage.
    // The init script above applies the id before the next app document runs.
  }
}

async function leaveCurrentWorkspaceDocument(page: Page): Promise<void> {
  if (page.url() === "about:blank") {
    return;
  }
  await page.goto("about:blank");
}

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

// Leave any mounted workspace before seeding. The app flushes pending session
// capture on pagehide; seeding from a neutral document prevents that old
// in-memory pane set from racing with the explicit test fixture.
export async function gotoWithWorkspaceSession(
  page: Page,
  deviceId: string,
  state: WorkspaceState,
  path: string,
): Promise<void> {
  await leaveCurrentWorkspaceDocument(page);
  await pinDeviceId(page, deviceId);
  await seedWorkspaceSession(page.request, deviceId, state);
  await page.goto(path);
}

export function activeWorkspacePane(page: Page): Locator {
  return page.locator(ACTIVE_WORKSPACE_PANE_SELECTOR).first();
}

export function activePaneSelector(selector: string): string {
  return `${ACTIVE_WORKSPACE_PANE_SELECTOR} ${selector}`;
}

export function workspaceE2eDeviceId(
  testInfo: TestInfo,
  prefix = "e2e-workspace",
): string {
  const slug = testInfo.titlePath
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `${prefix}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${slug}`;
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
