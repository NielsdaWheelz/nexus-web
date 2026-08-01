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

function escapedPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function exposeRailDestination(
  rail: Locator,
  label: string,
): Promise<Locator> {
  const namedDestination = rail.getByRole("button", {
    name: escapedPattern(label),
  });
  if ((await namedDestination.count()) > 0) {
    return namedDestination.first();
  }

  const clusters = rail.getByRole("button", {
    name: /\d+ destinations near \d+% through document/,
  });
  for (let index = 0; index < (await clusters.count()); index += 1) {
    await clusters.nth(index).click();
    if ((await namedDestination.count()) > 0) {
      return namedDestination.first();
    }
    await rail.getByRole("list").press("Escape");
  }
  throw new Error(`Document Map destination is not discoverable: ${label}`);
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
  await replaceReaderState(page, mediaId, locator);
}

async function replaceReaderState(
  page: Page,
  mediaId: string,
  locator: WebReaderResumeState,
): Promise<number> {
  const currentResponse = await page.request.get(
    `/api/media/${mediaId}/reader-state`,
  );
  expect(currentResponse.ok()).toBeTruthy();
  const current = ((await currentResponse.json()) as ReaderStateResponse).data;
  const response = await page.request.put(
    `/api/media/${mediaId}/reader-state`,
    {
      data: {
        locator,
        base_revision: current.state === "Empty" ? 0 : current.revision,
      },
      headers: stateChangingApiHeaders(),
    },
  );
  expect(response.ok()).toBeTruthy();
  const saved = ((await response.json()) as ReaderStateResponse).data;
  if (saved.state !== "Positioned") {
    throw new Error("Expected the reader-state write to publish a cursor");
  }
  return saved.revision;
}

function trackReaderStateWrites(page: Page, mediaId: string) {
  let count = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === `/api/media/${mediaId}/reader-state`
    ) {
      count += 1;
    }
  });
  return () => count;
}

test.describe("reader Document Map overview rail", () => {
  test("bare web route opens the saved fragment and exact quote without a save echo", async ({
    page,
  }, testInfo) => {
    const seed = readReaderDocumentMapSeed();
    const fragmentsResponse = await page.request.get(
      `/api/media/${seed.media_id}/fragments`,
    );
    expect(fragmentsResponse.ok()).toBeTruthy();
    const fragments = (
      (await fragmentsResponse.json()) as {
        data: Array<{ id: string; canonical_text: string }>;
      }
    ).data;
    const fragment = fragments.find(({ id }) => id === seed.far_fragment_id);
    if (!fragment) {
      throw new Error(`Missing seeded far fragment ${seed.far_fragment_id}`);
    }
    const utf16Offset = fragment.canonical_text.indexOf(seed.far_exact);
    if (utf16Offset < 0) {
      throw new Error(
        "The far fragment does not contain its reviewed exact text",
      );
    }
    const textOffset = [...fragment.canonical_text.slice(0, utf16Offset)]
      .length;
    const revision = await replaceReaderState(page, seed.media_id, {
      kind: "web",
      target: { fragment_id: seed.far_fragment_id },
      locations: {
        text_offset: textOffset,
        progression: textOffset / [...fragment.canonical_text].length,
        total_progression: null,
        position: 1,
      },
      text: {
        quote: seed.far_exact,
        quote_prefix: null,
        quote_suffix: null,
      },
    });

    await page.clock.install({ time: new Date("2026-07-31T12:00:00-07:00") });
    const readerStateWrites = trackReaderStateWrites(page, seed.media_id);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-document-map-resume"),
      `/media/${seed.media_id}`,
    );
    const pane = activeWorkspacePane(page);
    await expect(pane.getByText(seed.far_exact).first()).toBeInViewport({
      timeout: 15_000,
    });
    expect(page.url()).not.toMatch(/[?&](loc|fragment)=/);

    await page.clock.runFor(600);
    expect(readerStateWrites()).toBe(0);
    const savedResponse = await page.request.get(
      `/api/media/${seed.media_id}/reader-state`,
    );
    expect(savedResponse.ok()).toBeTruthy();
    const saved = ((await savedResponse.json()) as ReaderStateResponse).data;
    expect(saved).toMatchObject({
      state: "Positioned",
      revision,
      locator: {
        kind: "web",
        target: { fragment_id: seed.far_fragment_id },
        locations: { text_offset: textOffset },
      },
    });
  });

  test("rail shows markers across the whole document and jumps to an off-screen highlight", async ({
    page,
  }, testInfo) => {
    const seed = readReaderDocumentMapSeed();
    await resetReaderStateToDocumentStart(
      page,
      seed.media_id,
      seed.near_fragment_id,
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-reader-document-map"),
      `/media/${seed.media_id}`,
    );
    const activePane = activeWorkspacePane(page);
    const paneId = await activePane.getAttribute("data-pane-id");
    expect(paneId).toBeTruthy();

    // The reader renders only the first fragment on open: its near highlight is
    // on screen, the far fragment's highlight is not in the DOM at all.
    const nearHighlight = inlineHighlight(page, seed.near_highlight_id);
    await expect(nearHighlight).toBeVisible({ timeout: 15_000 });
    await expect(inlineHighlight(page, seed.far_highlight_id)).toHaveCount(0);

    // The overview rail is present on desktop but owns no generic opener. The
    // pane header's shared Companion is the single secondary-surface opener.
    const rail = activePane.getByTestId("reader-document-map-overview-rail");
    await expect(rail).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "Open Document Map" }),
    ).toHaveCount(0);
    await expect(
      activePane.getByRole("button", {
        name: "Open Document Map",
        exact: true,
      }),
    ).toHaveCount(0);
    const companionAction = activePane.getByRole("button", {
      name: "Companion",
      exact: true,
    });
    await expect(companionAction).toHaveCount(1);
    await expect(companionAction).toHaveAttribute("aria-expanded", "false");
    await expect(companionAction).not.toHaveAttribute("aria-controls");

    await companionAction.click();
    await expect(companionAction).toHaveAttribute("aria-expanded", "true");
    const controlledRegionId =
      await companionAction.getAttribute("aria-controls");
    expect(controlledRegionId).toBe(
      `pane-${paneId}-secondary-resource-inspector`,
    );
    const controlledRegion = activePane.locator(
      `aside[id="${controlledRegionId}"]`,
    );
    await expect(controlledRegion).toHaveCount(1);
    await expect(
      controlledRegion.getByRole("tab", {
        name: "Evidence",
        exact: true,
        selected: true,
      }),
    ).toHaveCount(1);
    await expect(page.locator(`[id="${controlledRegionId}"]`)).toHaveCount(1);
    await companionAction.click();
    await expect(companionAction).toHaveAttribute("aria-expanded", "false");
    await expect(companionAction).not.toHaveAttribute("aria-controls");
    await expect(
      activePane.locator(`aside[id="${controlledRegionId}"]`),
    ).toHaveCount(0);

    // The rail maps the whole media: it renders a marker for the on-screen near
    // highlight and a marker for the far highlight whose fragment is not rendered.
    const nearDestination = await exposeRailDestination(rail, seed.near_exact);
    await expect(nearDestination).toBeVisible();
    await expect(nearDestination).toHaveAccessibleName(
      escapedPattern(seed.near_exact),
    );
    await nearDestination.press("Escape");

    const farDestination = await exposeRailDestination(rail, seed.far_exact);
    await expect(farDestination).toBeVisible();
    await expect(farDestination).toHaveAccessibleName(
      escapedPattern(seed.far_exact),
    );

    // Clicking the off-screen destination navigates the reader to that highlight: its
    // fragment loads, the highlight renders inline, and the pulse scrolls it in.
    await farDestination.click();

    const farHighlight = inlineHighlight(page, seed.far_highlight_id);
    await expect(farHighlight).toBeAttached({ timeout: 15_000 });
    await expect(farHighlight).toContainText(seed.far_exact);
    await expect(farHighlight).toBeInViewport({ timeout: 15_000 });

    // The old in-view gutter is gone — no element and no test id anywhere.
    await expect(activePane.getByTestId("reader-gutter")).toHaveCount(0);
    await expect(activePane.locator(".reader-gutter")).toHaveCount(0);
  });
});
