import { test, expect, type Page } from "@playwright/test";
import {
  WORKSPACE_E2E_SCHEMA_VERSION,
  encodeWorkspaceStateParam,
  makeWorkspacePane,
} from "./workspace";

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("workspace pane minimize", () => {
  test("minimizes, persists, restores, and closes a pane", async ({ page }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
      activePaneId: "pane-libraries",
      panes: [
        makeWorkspacePane("pane-libraries", "/libraries", { widthPx: 480 }),
        makeWorkspacePane("pane-search", "/search", { widthPx: 480 }),
      ],
    });

    await page.goto(`/libraries?wsv=${WORKSPACE_E2E_SCHEMA_VERSION}&ws=${workspaceState}`);

    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeVisible();

    await workspacePaneButton(page, "Minimize Search").click();

    await expect(
      workspacePaneButton(page, /^Search\b.*Minimized\. Restore\./)
    ).toBeVisible();
    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeHidden();

    await page.reload();

    await expect(
      workspacePaneButton(page, /^Search\b.*Minimized\. Restore\./)
    ).toBeVisible();
    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeHidden();

    await workspacePaneButton(page, "Restore Search").click();

    await expect(page.getByPlaceholder("Search your Nexus content...")).toBeVisible();

    await workspacePaneButton(page, "Close Search").click();

    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
  });
});
