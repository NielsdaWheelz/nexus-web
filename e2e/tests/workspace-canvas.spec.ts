import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  expectNoDocumentHorizontalOverflow,
  expectPaneShellContainedByViewport,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

function workspacePaneStrip(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Workspace panes" });
}

function paneWrap(page: Page, paneId: string): Locator {
  return page.locator(`[data-pane-id="${paneId}"]`);
}

function edgeFade(page: Page, side: "start" | "end"): Locator {
  return page.getByTestId(`workspace-edge-fade-${side}`);
}

async function paneBoxX(pane: Locator): Promise<number> {
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

// Three same-width panes side by side overflow the 1280px desktop viewport,
// so the canvas is genuinely scrollable.
const OVERFLOWING_WORKSPACE_STATE: WorkspaceState = makeWorkspaceState(
  [
    makeWorkspacePane("pane-libraries", "/libraries"),
    makeWorkspacePane("pane-search", "/search"),
    makeWorkspacePane("pane-settings", "/settings"),
  ],
  { activePrimaryPaneId: "pane-libraries" },
);

test.describe("workspace canvas", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-workspace-canvas"),
      OVERFLOWING_WORKSPACE_STATE,
      "/libraries",
    );

    // Wait for every pane wrap to mount before driving the canvas.
    await expect(paneWrap(page, "pane-libraries")).toBeVisible();
    await expect(paneWrap(page, "pane-search")).toBeVisible();
    await expect(paneWrap(page, "pane-settings")).toBeVisible();
    await expect(workspacePaneStrip(page)).toBeVisible();
  });

  test("a vertical wheel over a pane header pans the canvas horizontally", async ({
    page,
  }) => {
    const firstPane = paneWrap(page, "pane-libraries");
    const startX = await paneBoxX(firstPane);

    // A vertical wheel over header chrome (no vertical scroll there) translates
    // to a horizontal pan.
    const header = paneWrap(page, "pane-libraries").getByTestId("pane-shell-chrome");
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2,
      headerBox!.y + headerBox!.height / 2,
    );
    await page.mouse.wheel(0, 400);

    await expect
      .poll(async () => paneBoxX(firstPane))
      .toBeLessThan(startX);
  });

  test("dragging a pane header pans the canvas", async ({ page }) => {
    const firstPane = paneWrap(page, "pane-libraries");
    const startX = await paneBoxX(firstPane);

    const header = paneWrap(page, "pane-libraries").getByTestId("pane-shell-chrome");
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    const grabY = headerBox!.y + headerBox!.height / 2;
    const grabX = headerBox!.x + headerBox!.width / 2;

    // Press the header, move left past the drag threshold in steps, release.
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX - 300, grabY, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => paneBoxX(firstPane))
      .toBeLessThan(startX);
  });

  test("pane-next and pane-previous step the active pane and bring it into view", async ({
    page,
  }) => {
    const stepChord = `ControlOrMeta+Shift+ArrowRight`;
    const backChord = `ControlOrMeta+Shift+ArrowLeft`;

    await expect(paneWrap(page, "pane-libraries")).toHaveAttribute(
      "data-active",
      "true",
    );
    await paneWrap(page, "pane-libraries")
      .getByTestId("pane-shell-chrome")
      .focus();

    // pane-next moves the active pane forward and centres it.
    await page.keyboard.press(stepChord);
    await expect(paneWrap(page, "pane-search")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(paneWrap(page, "pane-libraries")).toHaveAttribute(
      "data-active",
      "false",
    );
    await expect(paneWrap(page, "pane-search")).toBeInViewport();

    // pane-previous moves it back.
    await page.keyboard.press(backChord);
    await expect(paneWrap(page, "pane-libraries")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(paneWrap(page, "pane-libraries")).toBeInViewport();
  });

  test("edge fades signal off-screen panes and update as the canvas pans", async ({
    page,
  }) => {
    // At the start of the canvas only the trailing fade shows.
    await expect(edgeFade(page, "end")).toBeVisible();
    await expect(edgeFade(page, "start")).toHaveCount(0);

    // Pan right; the leading fade appears once panes sit off the start edge.
    const header = paneWrap(page, "pane-libraries").getByTestId("pane-shell-chrome");
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2,
      headerBox!.y + headerBox!.height / 2,
    );
    await page.mouse.wheel(0, 600);

    await expect(edgeFade(page, "start")).toBeVisible();
  });

  test("mobile mode removes desktop canvas affordances after resize", async ({
    page,
  }) => {
    await expect(edgeFade(page, "end")).toBeVisible();
    const header = paneWrap(page, "pane-libraries").getByTestId("pane-shell-chrome");
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2,
      headerBox!.y + headerBox!.height / 2,
    );
    await page.mouse.wheel(0, 600);
    await expect(edgeFade(page, "start")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });

    await expect(paneWrap(page, "pane-libraries")).toHaveAttribute(
      "data-mobile",
      "true",
    );
    await expect(workspacePaneStrip(page)).toHaveCount(0);
    await expect(
      page.locator('section[aria-label="Workspace host"] [data-pane-id]'),
    ).toHaveCount(1);
    await expect(edgeFade(page, "start")).toHaveCount(0);
    await expect(edgeFade(page, "end")).toHaveCount(0);
    await expectPaneShellContainedByViewport(paneWrap(page, "pane-libraries"));
    await expect(page.getByTestId("pane-fixed-chrome")).toHaveCount(0);
    await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
    await expect(
      page.getByRole("separator", { name: /^Resize pane / }),
    ).toHaveCount(0);
    await expectNoDocumentHorizontalOverflow(page);
  });
});

test("mobile-first restored multi-pane workspaces mount only mobile workspace chrome", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWithWorkspaceSession(
    page,
    workspaceE2eDeviceId(testInfo, "e2e-workspace-canvas-mobile-first"),
    OVERFLOWING_WORKSPACE_STATE,
    "/libraries",
  );

  await expect(paneWrap(page, "pane-libraries")).toHaveAttribute(
    "data-mobile",
    "true",
  );
  await expect(
    page.locator('section[aria-label="Workspace host"] [data-pane-id]'),
  ).toHaveCount(1);
  await expect(workspacePaneStrip(page)).toHaveCount(0);
  await expect(edgeFade(page, "start")).toHaveCount(0);
  await expect(edgeFade(page, "end")).toHaveCount(0);
  await expectPaneShellContainedByViewport(paneWrap(page, "pane-libraries"));
  await expect(page.getByTestId("pane-fixed-chrome")).toHaveCount(0);
  await expect(page.getByTestId("workspace-secondary-pane")).toHaveCount(0);
  await expect(page.getByRole("separator", { name: /^Resize pane / })).toHaveCount(
    0,
  );
  await expectNoDocumentHorizontalOverflow(page);
});
