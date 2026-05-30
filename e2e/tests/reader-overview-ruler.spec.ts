import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";
import { stateChangingApiHeaders } from "./api";

interface ReaderOverviewRulerSeed {
  media_id: string;
  near_fragment_id: string;
  near_highlight_id: string;
  near_exact: string;
  far_fragment_id: string;
  far_highlight_id: string;
  far_exact: string;
}

function readReaderOverviewRulerSeed(): ReaderOverviewRulerSeed {
  const seedPath = path.join(
    __dirname,
    "..",
    ".seed",
    "reader-overview-ruler-media.json",
  );
  const parsed = JSON.parse(
    readFileSync(seedPath, "utf-8"),
  ) as ReaderOverviewRulerSeed;

  const requiredFields: Array<keyof ReaderOverviewRulerSeed> = [
    "media_id",
    "near_fragment_id",
    "near_highlight_id",
    "near_exact",
    "far_fragment_id",
    "far_highlight_id",
    "far_exact",
  ];
  for (const field of requiredFields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(
        `Invalid reader-overview-ruler seed field "${field}" at ${seedPath}`,
      );
    }
  }
  return parsed;
}

function inlineHighlight(page: Page, highlightId: string): Locator {
  return activeWorkspacePane(page)
    .locator(`[data-active-highlight-ids~="${highlightId}"]`)
    .first();
}

function rulerTick(page: Page, highlightId: string): Locator {
  return activeWorkspacePane(page).getByTestId(`reader-overview-tick-${highlightId}`);
}

test.describe("reader overview ruler", () => {
  test("ruler shows ticks across the whole document and jumps to an off-screen highlight", async ({
    page,
  }, testInfo) => {
    const seed = readReaderOverviewRulerSeed();
    const resetResponse = await page.request.put(`/api/media/${seed.media_id}/reader-state`, {
      data: null,
      headers: stateChangingApiHeaders(),
    });
    expect(resetResponse.ok()).toBeTruthy();

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-overview-ruler"),
      `/media/${seed.media_id}`,
    );
    const activePane = activeWorkspacePane(page);

    // The reader renders only the first fragment on open: its near highlight is
    // on screen, the far fragment's highlight is not in the DOM at all.
    const nearHighlight = inlineHighlight(page, seed.near_highlight_id);
    await expect(nearHighlight).toBeVisible({ timeout: 15_000 });
    await expect(
      inlineHighlight(page, seed.far_highlight_id),
    ).toHaveCount(0);

    // The overview ruler is present on desktop, with its open-highlights button.
    const ruler = activePane.getByTestId("reader-overview-ruler");
    await expect(ruler).toBeVisible();
    await expect(
      ruler.getByRole("button", { name: "Open highlights pane" }),
    ).toBeVisible();

    // The ruler maps the whole media: it renders a tick for the on-screen near
    // highlight and a tick for the far highlight whose fragment is not rendered.
    await expect(rulerTick(page, seed.near_highlight_id)).toBeVisible();
    const farTick = rulerTick(page, seed.far_highlight_id);
    await expect(farTick).toBeVisible();

    // The far tick sits below the near tick because it is later in the document.
    const nearTickBox = await rulerTick(
      page,
      seed.near_highlight_id,
    ).boundingBox();
    const farTickBox = await farTick.boundingBox();
    expect(nearTickBox).not.toBeNull();
    expect(farTickBox).not.toBeNull();
    if (nearTickBox && farTickBox) {
      expect(farTickBox.y).toBeGreaterThan(nearTickBox.y);
    }

    // Clicking the off-screen tick navigates the reader to that highlight: its
    // fragment loads, the highlight renders inline, and the pulse scrolls it in.
    await farTick.click();

    const farHighlight = inlineHighlight(page, seed.far_highlight_id);
    await expect(farHighlight).toBeAttached({ timeout: 15_000 });
    await expect(farHighlight).toContainText(seed.far_exact);
    await expect(farHighlight).toBeInViewport({ timeout: 15_000 });

    // The old in-view gutter is gone — no element and no test id anywhere.
    await expect(activePane.getByTestId("reader-gutter")).toHaveCount(0);
    await expect(activePane.locator(".reader-gutter")).toHaveCount(0);
  });
});
