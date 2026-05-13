import { test, expect, type Page } from "@playwright/test";

function encodeWorkspaceStateParam(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test.describe("workspace pane minimize", () => {
  test("minimizes, persists, restores, and closes a pane", async ({ page }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 480,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 480,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

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
