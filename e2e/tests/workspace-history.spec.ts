import { test, expect, type Page } from "@playwright/test";
import {
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  type WorkspaceState,
} from "./workspace";

const WIDE_MEDIA_PANE_WIDTH_PX = 2200;

function paneWrap(page: Page, paneId: string) {
  return page.locator(`[data-pane-id="${paneId}"]`);
}

function paneBackButton(page: Page, paneId: string) {
  return paneWrap(page, paneId).getByRole("button", {
    name: "Go back in this pane",
  });
}

function paneForwardButton(page: Page, paneId: string) {
  return paneWrap(page, paneId).getByRole("button", {
    name: "Go forward in this pane",
  });
}

// The tab activator for a named pane in the workspace strip. Static routes
// resolve their title immediately, so the label tracks the pane's current
// href — which lets us assert a pane navigated without decoding any URL state.
function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

async function paneWidthPx(page: Page, paneId: string): Promise<number> {
  const box = await paneWrap(page, paneId).boundingBox();
  expect(box).not.toBeNull();
  return box!.width;
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

// The workspace primary default width — the value a pane resets to when it
// navigates to a route that does not own an intrinsic width. At runtime the
// probe makes default == min, so the separator's aria-valuemin reports it.
async function workspacePrimaryDefaultWidthPx(
  page: Page,
  paneId: string,
): Promise<number> {
  const value = await paneWrap(page, paneId)
    .getByRole("separator", { name: /^Resize pane / })
    .getAttribute("aria-valuemin");
  const widthPx = Number(value);
  expect(Number.isFinite(widthPx)).toBe(true);
  return widthPx;
}

test.describe("workspace pane history", () => {
  test("Back and Forward affect only the owning pane", async ({ page }, testInfo) => {
    // Two visible panes. The Notes pane never changes; the Search pane owns a
    // back-stack (one entry: /settings) so its in-app Back button is enabled.
    const workspaceState: WorkspaceState = {
      activePaneId: "pane-search",
      panes: [
        makeWorkspacePane("pane-notes", "/notes"),
        makeWorkspacePane("pane-search", "/search", {
          history: { back: ["/settings"], forward: [] },
        }),
      ],
    };

    await gotoWithWorkspaceSession(page, testInfo.testId, workspaceState, "/search");

    await expect(paneWrap(page, "pane-notes")).toBeVisible();
    await expect(paneWrap(page, "pane-search")).toBeVisible();
    // Both panes show their resolved static titles in the strip; the active
    // pane's href is the address bar, with no encoded layout params.
    await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
    await expect(page).toHaveURL(/\/search$/);

    // Click Back on the owning (Search) pane's chrome. Only that pane moves to
    // its previous href (/settings); the Notes pane is untouched.
    await paneBackButton(page, "pane-search").click();

    await expect(workspacePaneButton(page, /^Settings\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);
    await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible();
    // The owning pane is active, so the address bar follows it (replaceState),
    // never gaining an encoded-layout query param.
    await expect(page).toHaveURL(/\/settings$/);

    // Forward on the same pane returns it to /search; Notes is still untouched.
    await paneForwardButton(page, "pane-search").click();

    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Settings\b/)).toHaveCount(0);
    await expect(workspacePaneButton(page, /^Notes\b/)).toBeVisible();
    await expect(page).toHaveURL(/\/search$/);
  });

  test("Back from a wide media pane resets the list pane width and fills the body", async ({
    page,
  }, testInfo) => {
    const mediaHref = "/media/e2e-wide-route-fill";
    // A single wide media pane whose only back entry is the standard /libraries
    // route. Media routes allow an intrinsic (wide) primary width; /libraries
    // does not, so navigating Back must reset the pane to the default width.
    const workspaceState: WorkspaceState = {
      activePaneId: "pane-wide-media",
      panes: [
        makeWorkspacePane("pane-wide-media", mediaHref, {
          primaryWidthPx: WIDE_MEDIA_PANE_WIDTH_PX,
          history: { back: ["/libraries"], forward: [] },
        }),
      ],
    };

    await gotoWithWorkspaceSession(page, testInfo.testId, workspaceState, mediaHref);
    await expect(paneWrap(page, "pane-wide-media")).toBeVisible();

    await paneBackButton(page, "pane-wide-media").click();

    // The pane is now on /libraries: a standard-body route, active in the
    // address bar with no encoded-layout params.
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(
      paneWrap(page, "pane-wide-media").getByTestId("pane-shell-body"),
    ).toHaveAttribute("data-body-mode", "standard");

    // The rendered pane width collapses from the wide media width back to the
    // workspace default primary width (measured via boundingBox, not any URL
    // param). Allow 1px of sub-pixel layout slack.
    const defaultWidthPx = await workspacePrimaryDefaultWidthPx(
      page,
      "pane-wide-media",
    );
    await expect
      .poll(() => paneWidthPx(page, "pane-wide-media"))
      .toBeLessThan(WIDE_MEDIA_PANE_WIDTH_PX);
    await expect
      .poll(async () =>
        Math.abs((await paneWidthPx(page, "pane-wide-media")) - defaultWidthPx),
      )
      .toBeLessThanOrEqual(1);
    await expectRouteShellFillsBody(page, "pane-wide-media");
  });
});
