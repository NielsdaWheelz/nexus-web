import { test, expect, type Page } from "@playwright/test";
import {
  WORKSPACE_E2E_SCHEMA_VERSION,
  encodeWorkspaceStateParam,
  makeWorkspacePane,
  workspaceUrlForState,
  type WorkspaceState,
} from "./workspace";

const DEFAULT_DENSE_LIST_PANE_WIDTH_PX = 560;
const WIDE_MEDIA_PANE_WIDTH_PX = 2200;

function paneWrap(page: Page, paneId: string) {
  return page.locator(`[data-pane-id="${paneId}"]`);
}

async function workspaceStateFromUrl(page: Page): Promise<WorkspaceState> {
  const url = new URL(page.url());
  const encoded = url.searchParams.get("ws");
  expect(encoded).toBeTruthy();
  return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
}

async function expectRouteShellFillsBody(page: Page, paneId: string): Promise<void> {
  const body = paneWrap(page, paneId).getByTestId("pane-shell-body");

  await expect
    .poll(() =>
      body.evaluate((element) => {
        const routeShell = element.firstElementChild;
        if (!(routeShell instanceof HTMLElement)) {
          return false;
        }
        const bodyRect = element.getBoundingClientRect();
        const routeRect = routeShell.getBoundingClientRect();
        return (
          routeRect.width > 0 &&
          Math.abs(routeRect.left - bodyRect.left) <= 1 &&
          Math.abs(routeRect.right - bodyRect.right) <= 1
        );
      }),
    )
    .toBe(true);
}

test.describe("workspace pane history", () => {
  test("Back and Forward affect only the owning pane", async ({ page }) => {
    const workspaceState: WorkspaceState = {
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

  test("Back from a wide media pane resets the list pane width and fills the body", async ({
    page,
  }) => {
    const mediaHref = "/media/e2e-wide-route-fill";
    const workspaceState: WorkspaceState = {
      schemaVersion: WORKSPACE_E2E_SCHEMA_VERSION,
      activePaneId: "pane-wide-media",
      panes: [
        makeWorkspacePane("pane-wide-media", mediaHref, {
          widthPx: WIDE_MEDIA_PANE_WIDTH_PX,
          history: { back: ["/libraries"], forward: [] },
        }),
      ],
    };

    await page.goto(workspaceUrlForState(mediaHref, workspaceState));
    await expect(paneWrap(page, "pane-wide-media")).toBeVisible();

    await paneWrap(page, "pane-wide-media")
      .getByRole("button", { name: "Go back in this pane" })
      .click();

    await expect(
      paneWrap(page, "pane-wide-media").getByTestId("pane-shell-body"),
    ).toHaveAttribute("data-body-mode", "standard");
    await expect
      .poll(async () => {
        const state = await workspaceStateFromUrl(page);
        const pane = state.panes[0];
        return [pane?.href, pane?.widthPx, pane?.history.forward[0]];
      })
      .toEqual(["/libraries", DEFAULT_DENSE_LIST_PANE_WIDTH_PX, mediaHref]);
    await expectRouteShellFillsBody(page, "pane-wide-media");
  });
});
