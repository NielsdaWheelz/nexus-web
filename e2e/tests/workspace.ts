import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { stateChangingApiHeaders } from "./api";

type WorkspacePaneVisibility = "visible" | "minimized";

// The app stores the device id under this key in localStorage. Pinning it lets
// a test key its server-session capture + restore to an id it controls.
export const INSTALLATION_ID_STORAGE_KEY = "nexus.installationId.v1";

const WORKSPACE_SESSION_PATH = "/api/me/workspace-session";
const WORKSPACE_DEFAULT_FALLBACK_HREF = "/libraries";
const EXPLICIT_FALLBACK_HISTORY: WorkspacePaneHistory = {
  back: ["/browse"],
  forward: [],
};
const WORKSPACE_SESSION_SEED_ATTEMPTS = 3;
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
    | "reader-contents"
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
  const history =
    options?.history ??
    (href === WORKSPACE_DEFAULT_FALLBACK_HREF
      ? EXPLICIT_FALLBACK_HISTORY
      : undefined);
  const paneId = options?.paneId ?? "pane-e2e-primary";
  return makeWorkspaceState(
    [
      makeWorkspacePane(paneId, href, {
        primaryWidthPx: options?.primaryWidthPx ?? 684,
        history,
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
        /* private mode / quota - ignored */
      }
    },
    [INSTALLATION_ID_STORAGE_KEY, deviceId],
  );
  try {
    await page.evaluate(
      ([key, id]) => {
        try {
          localStorage.setItem(key, id);
        } catch {
          /* private mode / quota - ignored */
        }
      },
      [INSTALLATION_ID_STORAGE_KEY, deviceId],
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

function isWorkspaceSessionRestoreResponse(
  response: Response,
  deviceId: string,
): boolean {
  const request = response.request();
  if (request.method() !== "GET") {
    return false;
  }
  const url = new URL(response.url());
  return (
    url.pathname === WORKSPACE_SESSION_PATH &&
    url.searchParams.get("device_id") === deviceId
  );
}

export async function seedWorkspaceSession(
  request: APIRequestContext,
  deviceId: string,
  state: WorkspaceState,
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < WORKSPACE_SESSION_SEED_ATTEMPTS; attempt += 1) {
    try {
      const response = await request.put(WORKSPACE_SESSION_PATH, {
        headers: stateChangingApiHeaders(),
        data: { device_id: deviceId, state },
      });
      if (response.ok()) {
        return;
      }
      lastError = new Error(
        `PUT ${WORKSPACE_SESSION_PATH} failed: status=${response.status()}; body=${(await response.text()).slice(0, 400)}`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < WORKSPACE_SESSION_SEED_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`PUT ${WORKSPACE_SESSION_PATH} failed while seeding workspace session.`);
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
  const restoreResponse = page
    .waitForResponse(
      (response) => isWorkspaceSessionRestoreResponse(response, deviceId),
      { timeout: 15_000 },
    )
    .catch(() => null);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await restoreResponse;
}

export function activeWorkspacePane(page: Page): Locator {
  return page.locator(ACTIVE_WORKSPACE_PANE_SELECTOR).first();
}

export async function expectPaneShellContainedByViewport(
  pane: Locator,
): Promise<void> {
  await expect
    .poll(() =>
      pane.getByTestId("pane-shell-root").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          rect.width <= window.innerWidth + 1
        );
      }),
    )
    .toBe(true);
}

export async function expectActivePaneShellContainedByViewport(
  page: Page,
): Promise<void> {
  await expectPaneShellContainedByViewport(activeWorkspacePane(page));
}

export async function expectNoDocumentHorizontalOverflow(
  page: Page,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Math.max(
            document.body.scrollWidth,
            document.documentElement.scrollWidth,
          ) - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
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
  return `${prefix}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}-${slug}`;
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
