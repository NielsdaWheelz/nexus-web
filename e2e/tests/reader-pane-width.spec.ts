import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openReaderSecondary } from "./reader";
import {
  activeWorkspacePane,
  expectNoDocumentHorizontalOverflow,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

interface MediaSeed {
  media_id: string;
}

function readSeed(seedFile: string): MediaSeed {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as MediaSeed;
}

function paneShell(activePane: Locator): Locator {
  return activePane.getByTestId("pane-shell-root");
}

function resizeHandle(activePane: Locator): Locator {
  return activePane.getByRole("separator", { name: /^Resize pane / });
}

async function numericAttribute(locator: Locator, name: string): Promise<number> {
  const value = await locator.getAttribute(name);
  return Number(value);
}

async function waitForReflowableReader(activePane: Locator): Promise<void> {
  await expect(activePane.getByTestId("document-viewport")).toBeVisible({
    timeout: 20_000,
  });
  await expect(activePane.getByTestId("html-renderer").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(activePane.getByTestId("reader-document-map-overview-rail")).toBeVisible({
    timeout: 20_000,
  });
}

async function expectReflowableFloor(
  page: Page,
  deviceId: string,
  mediaId: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(page, deviceId, `/media/${mediaId}`, { primaryWidthPx: 320 });
  const activePane = activeWorkspacePane(page);
  await waitForReflowableReader(activePane);

  const handle = resizeHandle(activePane);
  await expect
    .poll(() => numericAttribute(handle, "aria-valuemin"))
    .toBeGreaterThan(320);
  const floor = await numericAttribute(handle, "aria-valuemin");
  await expect.poll(() => numericAttribute(handle, "aria-valuenow")).toBe(floor);

  await handle.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => numericAttribute(handle, "aria-valuenow")).toBe(floor);

  const closedWidth = await paneShell(activePane).evaluate((element) =>
    Math.round(element.getBoundingClientRect().width),
  );
  await openReaderSecondary(page);
  await expect
    .poll(() =>
      paneShell(activePane).evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBeGreaterThanOrEqual(closedWidth + 300);

  await activePane.getByRole("button", { name: /^Close / }).click();
  await expect
    .poll(() =>
      paneShell(activePane).evaluate((element) =>
        Math.round(element.getBoundingClientRect().width),
      ),
    )
    .toBe(closedWidth);
}

test.describe("reader pane width floor", () => {
  test("web article panes cannot stay below the configured text floor", async ({
    page,
  }, testInfo) => {
    await expectReflowableFloor(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-pane-width"),
      readSeed("non-pdf-media.json").media_id,
    );
  });

  test("EPUB panes cannot stay below the configured text floor", async ({
    page,
  }, testInfo) => {
    await expectReflowableFloor(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-pane-width"),
      readSeed("epub-media.json").media_id,
    );
  });

  test("PDF panes use intrinsic page width and transcripts use the workspace floor", async ({
    page,
  }, testInfo) => {
    const pdf = readSeed("pdf-media.json");
    const deviceId = workspaceE2eDeviceId(testInfo, "e2e-reader-pane-width");
    await gotoSinglePaneWorkspace(page, deviceId, `/media/${pdf.media_id}`, {
      primaryWidthPx: 320,
    });
    let activePane = activeWorkspacePane(page);
    await expect(activePane.getByRole("toolbar", { name: "PDF controls" })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => numericAttribute(resizeHandle(activePane), "aria-valuemin"))
      .toBeGreaterThan(320);
    const pdfFloor = await numericAttribute(resizeHandle(activePane), "aria-valuemin");
    await expect
      .poll(() => numericAttribute(resizeHandle(activePane), "aria-valuenow"))
      .toBe(pdfFloor);

    const youtube = readSeed("youtube-media.json");
    await gotoSinglePaneWorkspace(page, deviceId, `/media/${youtube.media_id}`, {
      primaryWidthPx: 320,
    });
    activePane = activeWorkspacePane(page);
    await expect(activePane.getByTestId("document-viewport")).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => numericAttribute(resizeHandle(activePane), "aria-valuemin"))
      .toBeGreaterThan(320);
    const transcriptFloor = await numericAttribute(
      resizeHandle(activePane),
      "aria-valuemin",
    );
    await expect
      .poll(() => numericAttribute(resizeHandle(activePane), "aria-valuenow"))
      .toBe(transcriptFloor);
  });

  test("mobile reflowable readers use viewport width instead of desktop floors", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-pane-width"),
      `/media/${readSeed("non-pdf-media.json").media_id}`,
      { primaryWidthPx: 320 },
    );

    const activePane = activeWorkspacePane(page);
    await expect(activePane.getByTestId("document-viewport")).toBeVisible({
      timeout: 20_000,
    });
    await expect(paneShell(activePane)).toHaveAttribute("data-mobile", "true");
    await expect
      .poll(() =>
        paneShell(activePane).evaluate((element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
      )
      .toBeLessThanOrEqual(390);
    await expect(resizeHandle(activePane)).toHaveCount(0);
    await expect(activePane.getByTestId("reader-document-map-overview-rail")).toHaveCount(0);
    await expect(activePane.getByTestId("pane-fixed-chrome")).toHaveCount(0);
    await expectNoDocumentHorizontalOverflow(page);
  });
});
