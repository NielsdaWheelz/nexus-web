import { test, expect, type Page } from "@playwright/test";
import {
  WORKSPACE_E2E_SCHEMA_VERSION,
  encodeWorkspaceStateParam,
  makeWorkspacePane,
  type WorkspaceStateV5,
} from "./workspace";

function paneWrap(page: Page, paneId: string) {
  return page.locator(`[data-pane-id="${paneId}"]`);
}

async function workspaceStateFromUrl(page: Page): Promise<WorkspaceStateV5> {
  const url = new URL(page.url());
  const encoded = url.searchParams.get("ws");
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
}

test.describe("workspace pane history", () => {
  test("Back and Forward affect only the owning pane", async ({ page }) => {
    const workspaceState: WorkspaceStateV5 = {
      schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
      activePaneId: "pane-search",
      panes: [
        makeWorkspacePane("pane-libraries", "/libraries"),
        makeWorkspacePane("pane-search", "/search", {
          history: { back: ["/libraries"], forward: ["/settings"] },
        }),
      ],
    };

    await page.goto(
      `/search?wsv=${WORKSPACE_E2E_SCHEMA_VERSION}&ws=${encodeWorkspaceStateParam(workspaceState)}`,
    );
    await expect(paneWrap(page, "pane-libraries")).toBeVisible();
    await expect(paneWrap(page, "pane-search")).toBeVisible();

    await paneWrap(page, "pane-search")
      .getByRole("button", { name: "Go back in this pane" })
      .click();

    await expect
      .poll(async () => {
        const state = await workspaceStateFromUrl(page);
        return state.panes.map((pane) => [pane.id, pane.href, pane.history]);
      })
      .toEqual([
        ["pane-libraries", "/libraries", { back: [], forward: [] }],
        ["pane-search", "/libraries", { back: [], forward: ["/search", "/settings"] }],
      ]);

    await paneWrap(page, "pane-search")
      .getByRole("button", { name: "Go forward in this pane" })
      .click();

    await expect
      .poll(async () => {
        const state = await workspaceStateFromUrl(page);
        return state.panes.map((pane) => [pane.id, pane.href, pane.history]);
      })
      .toEqual([
        ["pane-libraries", "/libraries", { back: [], forward: [] }],
        ["pane-search", "/search", { back: ["/libraries"], forward: ["/settings"] }],
      ]);
  });
});
