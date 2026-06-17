import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";
import { stateChangingApiHeaders } from "./api";

interface ReaderDocumentMapSeed {
  media_id: string;
  near_fragment_id: string;
  near_highlight_id: string;
  near_exact: string;
  far_fragment_id: string;
  far_highlight_id: string;
  far_exact: string;
}

function readReaderDocumentMapSeed(): ReaderDocumentMapSeed {
  const seedPath = path.join(
    __dirname,
    "..",
    ".seed",
    "reader-document-map-media.json",
  );
  const parsed = JSON.parse(
    readFileSync(seedPath, "utf-8"),
  ) as ReaderDocumentMapSeed;

  const requiredFields: Array<keyof ReaderDocumentMapSeed> = [
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
        `Invalid reader-document-map seed field "${field}" at ${seedPath}`,
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

function railMarker(page: Page, highlightId: string): Locator {
  return activeWorkspacePane(page).getByTestId(
    `reader-document-map-marker-marker:highlights:highlight:${highlightId}`,
  );
}

test.describe("reader Document Map overview rail", () => {
  test("rail shows markers across the whole document and jumps to an off-screen highlight", async ({
    page,
  }, testInfo) => {
    const seed = readReaderDocumentMapSeed();
    const resetResponse = await page.request.put(`/api/media/${seed.media_id}/reader-state`, {
      data: null,
      headers: stateChangingApiHeaders(),
    });
    expect(resetResponse.ok()).toBeTruthy();

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-document-map"),
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

    // The overview rail is present on desktop, with its Document Map button.
    const rail = activePane.getByTestId("reader-document-map-overview-rail");
    await expect(rail).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Open Document Map" }),
    ).toBeVisible();

    // The rail maps the whole media: it renders a marker for the on-screen near
    // highlight and a marker for the far highlight whose fragment is not rendered.
    await expect(railMarker(page, seed.near_highlight_id)).toBeVisible();
    const farMarker = railMarker(page, seed.far_highlight_id);
    await expect(farMarker).toBeVisible();

    // The far marker sits below the near marker because it is later in the document.
    const nearMarkerBox = await railMarker(
      page,
      seed.near_highlight_id,
    ).boundingBox();
    const farMarkerBox = await farMarker.boundingBox();
    expect(nearMarkerBox).not.toBeNull();
    expect(farMarkerBox).not.toBeNull();
    if (nearMarkerBox && farMarkerBox) {
      expect(farMarkerBox.y).toBeGreaterThan(nearMarkerBox.y);
    }

    // Clicking the off-screen marker navigates the reader to that highlight: its
    // fragment loads, the highlight renders inline, and the pulse scrolls it in.
    await farMarker.click();

    const farHighlight = inlineHighlight(page, seed.far_highlight_id);
    await expect(farHighlight).toBeAttached({ timeout: 15_000 });
    await expect(farHighlight).toContainText(seed.far_exact);
    await expect(farHighlight).toBeInViewport({ timeout: 15_000 });

    // The old in-view gutter is gone — no element and no test id anywhere.
    await expect(activePane.getByTestId("reader-gutter")).toHaveCount(0);
    await expect(activePane.locator(".reader-gutter")).toHaveCount(0);
  });
});
