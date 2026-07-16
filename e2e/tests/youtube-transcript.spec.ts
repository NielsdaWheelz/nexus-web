import { test, expect, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openEvidencePane, openMediaInSinglePaneWorkspace } from "./reader";
import { selectFreshVisibleTextSnippet } from "./selection";
import { stateChangingApiHeaders } from "./api";
import {
  activePaneSelector,
  activeWorkspacePane,
  workspaceE2eDeviceId,
} from "./workspace";

interface SeededYoutubeMedia {
  media_id: string;
  playback_only_media_id: string;
  watch_url: string;
  embed_url: string;
  seek_segment_text: string;
  seek_segment_start_ms: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSeededYoutubeMedia(): SeededYoutubeMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "youtube-media.json");
  const raw = readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeededYoutubeMedia;

  const requiredStringFields: Array<keyof SeededYoutubeMedia> = [
    "media_id",
    "playback_only_media_id",
    "watch_url",
    "embed_url",
    "seek_segment_text",
  ];
  for (const field of requiredStringFields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid seeded YouTube metadata field "${field}" at ${seedPath}`);
    }
  }
  if (
    typeof parsed.seek_segment_start_ms !== "number" ||
    !Number.isFinite(parsed.seek_segment_start_ms) ||
    parsed.seek_segment_start_ms < 0
  ) {
    throw new Error(`Invalid seek_segment_start_ms in ${seedPath}`);
  }

  return parsed;
}

function transcriptSegmentButton(activePane: Locator, text: string): Locator {
  return activePane.getByRole("button", {
    name: new RegExp(`^\\d{2}:\\d{2}:\\d{2}\\s+.*${escapeRegExp(text)}$`, "i"),
  });
}

test.describe("youtube transcript media", () => {
  test("transcript-ready youtube flow renders embed, seeks by transcript click, and keeps external source action", async ({
    page,
  }, testInfo) => {
    const seed = readSeededYoutubeMedia();
    const expectedStartSeconds = Math.floor(seed.seek_segment_start_ms / 1000);

    await openMediaInSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-youtube"),
      seed.media_id,
    );

    const activePane = activeWorkspacePane(page);
    const playerFrame = activePane.locator("iframe").first();
    await expect(playerFrame).toBeVisible({ timeout: 10_000 });
    await expect(activePane.locator("video")).toHaveCount(0);

    await expect(activePane.getByRole("link", { name: /open in source/i })).toHaveAttribute(
      "href",
      seed.watch_url
    );

    const seekSegmentButton = transcriptSegmentButton(activePane, seed.seek_segment_text);
    await expect(seekSegmentButton).toBeVisible({ timeout: 10_000 });
    await seekSegmentButton.click();

    await expect
      .poll(async () => (await playerFrame.getAttribute("src")) ?? "", {
        timeout: 10_000,
      })
      .toContain(`start=${expectedStartSeconds}`);
    await expect
      .poll(async () => (await playerFrame.getAttribute("src")) ?? "", {
        timeout: 10_000,
      })
      .toContain("autoplay=1");
  });

  test("creates a highlight from transcript content and shows it in the linked items pane", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readSeededYoutubeMedia();
    await openMediaInSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-youtube"),
      seed.media_id,
    );

    const activePane = activeWorkspacePane(page);
    const seekSegmentButton = transcriptSegmentButton(activePane, seed.seek_segment_text);
    await expect(seekSegmentButton).toBeVisible({ timeout: 10_000 });
    await seekSegmentButton.click();

    const transcriptContent = activePane.locator(
      '[data-testid="document-viewport"] [data-testid="html-renderer"]'
    );
    await expect(transcriptContent).toContainText(seed.seek_segment_text, { timeout: 10_000 });

    const fragmentsResponse = await page.request.get(`/api/media/${seed.media_id}/fragments`);
    expect(fragmentsResponse.ok()).toBeTruthy();
    const fragmentsPayload = (await fragmentsResponse.json()) as {
      data: Array<{ id: string; canonical_text: string }>;
    };
    const targetFragment = fragmentsPayload.data.find(
      (fragment) =>
        fragment.canonical_text === seed.seek_segment_text ||
        fragment.canonical_text.includes(seed.seek_segment_text)
    );
    expect(targetFragment).toBeTruthy();
    if (!targetFragment) {
      throw new Error(`Expected transcript fragment for "${seed.seek_segment_text}".`);
    }

    const existingHighlightsResponse = await page.request.get(
      `/api/fragments/${targetFragment.id}/highlights`
    );
    expect(existingHighlightsResponse.ok()).toBeTruthy();
    const existingHighlightsPayload = (await existingHighlightsResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const existingExacts = existingHighlightsPayload.data.highlights.map((highlight) => highlight.exact);

    const evidencePane = await openEvidencePane(page);
    const linkedRows = evidencePane.locator("[data-highlight-id]");
    const highlightedSegments = transcriptContent.locator("[data-active-highlight-ids]");
    const beforeLinkedRowCount = await linkedRows.count();
    const beforeHighlightedCount = await highlightedSegments.count();
    // The author byline + video embed + capped segment list push the transcript
    // reader surface below the initial fold; bring it into view so the selection
    // helper (which reads visible client rects and never scrolls) can find text.
    await transcriptContent.scrollIntoViewIfNeeded();
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      activePaneSelector(
        '[data-testid="document-viewport"] [data-testid="html-renderer"]'
      ),
      existingExacts
    );

    const highlightActions = page.getByRole("group", { name: /selection actions/i });
    await expect(highlightActions).toBeVisible({ timeout: 5_000 });

    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${targetFragment.id}/highlights`)
    );
    await highlightActions.getByRole("button", { name: "Highlight color" }).click();
    await page
      .getByRole("button", { name: /^Green$/ })
      .first()
      .click();
    const createdHighlightResponse = await createHighlightResponse;
    expect(createdHighlightResponse.ok()).toBeTruthy();

    const linkedRow = linkedRows.filter({ hasText: selectedText }).first();
    await expect(linkedRow).toBeVisible({ timeout: 10_000 });
    await expect(linkedRow).toContainText(selectedText);
    await expect(highlightActions).toHaveCount(0);

    await expect
      .poll(async () => linkedRows.count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeLinkedRowCount);
    await expect
      .poll(async () => highlightedSegments.count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeHighlightedCount);
    await expect(
      transcriptContent.locator("[data-active-highlight-ids]").filter({ hasText: selectedText }).first()
    ).toBeVisible();
  });

  test("playback-only youtube media shows explicit transcript-unavailable gating", async ({
    page,
  }, testInfo) => {
    const seed = readSeededYoutubeMedia();
    await openMediaInSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-youtube"),
      seed.playback_only_media_id,
    );

    const activePane = activeWorkspacePane(page);
    await expect(activePane.locator("iframe").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      activePane.getByText("Transcript unavailable for this episode.")
    ).toBeVisible();
    await expect(
      transcriptSegmentButton(activePane, seed.seek_segment_text)
    ).toHaveCount(0);
    await expect(activePane.getByRole("link", { name: /open in source/i })).toHaveAttribute(
      "href",
      /youtube\.com\/watch\?v=/
    );
  });

  // AC-6: Reader Theme completes the boundary for transcript content
  // (segments/timeline/active prose share one themed root) while playback,
  // app chrome, and workspace chrome stay app-themed.
  test("reader theme completes the boundary for transcript content while playback and app chrome stay unaffected", async ({
    page,
  }, testInfo) => {
    const seed = readSeededYoutubeMedia();

    // The seed user's reader profile is account-global and shared across
    // specs; pin a known starting point before asserting the dark switch.
    const pinLight = await page.request.patch("/api/me/reader-profile", {
      data: { theme: "light" },
      headers: stateChangingApiHeaders(),
    });
    expect(pinLight.ok()).toBeTruthy();

    try {
      await openMediaInSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-youtube-theme"),
        seed.media_id,
      );
      const activePane = activeWorkspacePane(page);
      const documentViewport = activePane.locator('[data-testid="document-viewport"]');
      await expect(documentViewport).toBeVisible({ timeout: 10_000 });
      const playerFrame = activePane.locator("iframe").first();
      await expect(playerFrame).toBeVisible({ timeout: 10_000 });

      const primaryNav = page.getByRole("navigation", { name: "Primary" });
      const navBackgroundBefore = await primaryNav.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      const playerBackgroundBefore = await playerFrame.evaluate(
        (el) =>
          getComputedStyle(el.closest('[class*="playerPanel"]') ?? el).backgroundColor,
      );

      const optionsTrigger = activePane.getByRole("button", { name: "Options" }).first();
      await expect(optionsTrigger).toBeVisible();
      await optionsTrigger.click();
      await page.getByRole("menuitem", { name: "Dark theme", exact: true }).click();

      // The transcript content root (segments/timeline/active prose share the
      // one themed root per the transcript theme-composition cutover) reflects
      // the dark reader theme.
      const themedRoot = documentViewport.locator('[class*="readerThemeDark"]').first();
      await expect(themedRoot).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(() => themedRoot.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe("rgb(21, 20, 15)");

      // The playback panel (player/chapters/show notes) is a sibling of the
      // themed transcript root, not a descendant, and its background is
      // untouched by the reading-surface theme switch.
      const playerAncestorIsThemed = await playerFrame.evaluate(
        (el) => el.closest('[class*="readerThemeDark"]') !== null,
      );
      expect(playerAncestorIsThemed).toBe(false);
      const playerBackgroundAfter = await playerFrame.evaluate(
        (el) =>
          getComputedStyle(el.closest('[class*="playerPanel"]') ?? el).backgroundColor,
      );
      expect(playerBackgroundAfter).toBe(playerBackgroundBefore);

      // App chrome (header/nav) is unaffected by the reading-surface theme.
      const navBackgroundAfter = await primaryNav.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(navBackgroundAfter).toBe(navBackgroundBefore);

      // Reduced motion: toggling the theme back applies with no transition.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await optionsTrigger.click();
      await page.getByRole("menuitem", { name: "Light theme", exact: true }).click();
      const lightRoot = documentViewport.locator('[class*="readerThemeLight"]').first();
      await expect(lightRoot).toBeVisible({ timeout: 10_000 });
      const transitionDuration = await lightRoot.evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      );
      expect(transitionDuration).toBe("0s");
    } finally {
      const restore = await page.request.patch("/api/me/reader-profile", {
        data: { theme: "light" },
        headers: stateChangingApiHeaders(),
      });
      expect(restore.ok()).toBeTruthy();
    }
  });
});
