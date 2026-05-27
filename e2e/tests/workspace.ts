import { expect, type Locator, type Page } from "@playwright/test";

type WorkspacePaneVisibility = "visible" | "minimized";

interface WorkspacePaneStateV4 {
  id: string;
  href: string;
  widthPx: number;
  visibility: WorkspacePaneVisibility;
}

interface WorkspaceStateV4 {
  schemaVersion: 4;
  activePaneId: string;
  panes: WorkspacePaneStateV4[];
}

export function encodeWorkspaceStateParam(value: WorkspaceStateV4): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function workspaceUrlForState(
  href: string,
  state: WorkspaceStateV4,
): string {
  const url = new URL(href, "http://nexus-e2e.local");
  url.searchParams.set("wsv", "4");
  url.searchParams.set("ws", encodeWorkspaceStateParam(state));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function singlePaneWorkspaceState(
  href: string,
  options?: { paneId?: string; widthPx?: number },
): WorkspaceStateV4 {
  const paneId = options?.paneId ?? "pane-e2e-primary";
  const widthPx =
    options?.widthPx ?? (new URL(href, "http://nexus-e2e.local").pathname.startsWith("/media/")
      ? 1280
      : 560);
  return {
    schemaVersion: 4,
    activePaneId: paneId,
    panes: [{ id: paneId, href, widthPx, visibility: "visible" }],
  };
}

export function workspaceUrlForSinglePane(
  href: string,
  options?: { paneId?: string; widthPx?: number },
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
  options?: { paneId?: string; widthPx?: number },
): Promise<void> {
  await page.goto(workspaceUrlForSinglePane(href, options));
  await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
}
