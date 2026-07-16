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

interface ReaderTextLocations {
  text_offset: number | null;
  progression: number | null;
  total_progression: number | null;
  position: number | null;
}

interface ReaderTextQuote {
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
}

interface WebReaderResumeState {
  kind: "web";
  target: {
    fragment_id: string;
  };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

// Wire contract: GET/PUT never return a bare locator or null. Empty has no
// locator at all; Positioned always carries one alongside the revision used
// for conditional writes.
type ReaderCursorSnapshot =
  | { state: "Empty"; revision: 0 }
  | { state: "Positioned"; revision: number; locator: WebReaderResumeState };

interface ReaderStateResponse {
  data: ReaderCursorSnapshot;
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

// There is no clear/delete semantics under the new contract (a cursor row can
// only be replaced, never removed), so "no meaningful saved position" is
// expressed as a cursor at the very beginning of the document (the near
// fragment, which is fragment 0) rather than an Empty cursor. That reproduces
// the same "only fragment 0 is rendered on open" behavior this test needs,
// via a conditional write against the current revision.
async function resetReaderStateToDocumentStart(
  page: Page,
  mediaId: string,
  fragmentId: string,
): Promise<void> {
  const currentResponse = await page.request.get(`/api/media/${mediaId}/reader-state`);
  expect(currentResponse.ok()).toBeTruthy();
  const current = ((await currentResponse.json()) as ReaderStateResponse).data;
  const baseRevision = current.state === "Empty" ? 0 : current.revision;

  const locator: WebReaderResumeState = {
    kind: "web",
    target: { fragment_id: fragmentId },
    locations: {
      text_offset: 0,
      progression: 0,
      total_progression: 0,
      position: 1,
    },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  };

  const resetResponse = await page.request.put(`/api/media/${mediaId}/reader-state`, {
    data: { cursor: { locator, base_revision: baseRevision } },
    headers: stateChangingApiHeaders(),
  });
  expect(resetResponse.ok()).toBeTruthy();
}

test.describe("reader Document Map overview rail", () => {
  test("rail shows markers across the whole document and jumps to an off-screen highlight", async ({
    page,
  }, testInfo) => {
    const seed = readReaderDocumentMapSeed();
    await resetReaderStateToDocumentStart(page, seed.media_id, seed.near_fragment_id);

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
