import { expect, type Locator, type Page } from "@playwright/test";

type WorkspacePaneVisibility = "visible" | "minimized";

export const WORKSPACE_E2E_SCHEMA_VERSION = 8;

export interface WorkspacePaneHistory {
  back: string[];
  forward: string[];
}

export interface WorkspacePaneState {
  id: string;
  href: string;
  primaryWidthPx: number;
  sidecar: null;
  visibility: WorkspacePaneVisibility;
  history: WorkspacePaneHistory;
}

export interface WorkspaceState {
  schemaVersion: typeof WORKSPACE_E2E_SCHEMA_VERSION;
  activePaneId: string;
  panes: WorkspacePaneState[];
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
    sidecar: null,
    visibility: options?.visibility ?? "visible",
    history: options?.history ?? { back: [], forward: [] },
  };
}

export function encodeWorkspaceStateParam(value: WorkspaceState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function workspaceUrlForState(
  href: string,
  state: WorkspaceState,
): string {
  const url = new URL(href, "http://nexus-e2e.local");
  url.searchParams.set("wsv", String(WORKSPACE_E2E_SCHEMA_VERSION));
  url.searchParams.set("ws", encodeWorkspaceStateParam(state));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function singlePaneWorkspaceState(
  href: string,
  options?: { paneId?: string; primaryWidthPx?: number; history?: WorkspacePaneHistory },
): WorkspaceState {
  const paneId = options?.paneId ?? "pane-e2e-primary";
  const primaryWidthPx = options?.primaryWidthPx ?? 684;
  return {
    schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
    activePaneId: paneId,
    panes: [
      makeWorkspacePane(paneId, href, {
        primaryWidthPx,
        history: options?.history,
      }),
    ],
  };
}

export function workspaceUrlForSinglePane(
  href: string,
  options?: { paneId?: string; primaryWidthPx?: number; history?: WorkspacePaneHistory },
): string {
  return workspaceUrlForState(href, singlePaneWorkspaceState(href, options));
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
  href: string,
  options?: { paneId?: string; primaryWidthPx?: number; history?: WorkspacePaneHistory },
): Promise<void> {
  await page.goto(workspaceUrlForSinglePane(href, options));
  await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
}
