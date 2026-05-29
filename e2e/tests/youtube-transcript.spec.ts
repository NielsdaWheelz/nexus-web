import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { selectFreshVisibleTextSnippet } from "./selection";

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

async function openHighlightsPane(page: Page): Promise<Locator> {
  const sidecar = page.getByTestId("workspace-sidecar-pane");
  if ((await sidecar.count()) > 0 && (await sidecar.isVisible().catch(() => false))) {
    await sidecar.getByRole("tab", { name: "Highlights" }).click();
  } else {
    await page.getByRole("button", { name: "Open highlights pane" }).click();
  }
  await expect(sidecar).toBeVisible({ timeout: 10_000 });
  await expect(sidecar.getByRole("tab", { name: "Highlights" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return page.getByTestId("anchored-highlights-container").first();
}


test.describe("youtube transcript media", () => {
  test("transcript-ready youtube flow renders embed, seeks by transcript click, and keeps external source action", async ({
    page,
  }) => {
    const seed = readSeededYoutubeMedia();
    const expectedStartSeconds = Math.floor(seed.seek_segment_start_ms / 1000);

    await page.goto(`/media/${seed.media_id}`);

    const playerFrame = page.locator('iframe[title="YouTube video player"]');
    await expect(playerFrame).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);

    await expect(page.getByRole("link", { name: /open in source/i })).toHaveAttribute(
      "href",
      seed.watch_url
    );

    const seekSegmentButton = page.getByRole("button", {
      name: new RegExp(escapeRegExp(seed.seek_segment_text), "i"),
    });
    await expect(seekSegmentButton).toBeVisible();
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
  }) => {
    test.slow();

    const seed = readSeededYoutubeMedia();
    await page.goto(`/media/${seed.media_id}`);

    const seekSegmentButton = page.getByRole("button", {
      name: new RegExp(escapeRegExp(seed.seek_segment_text), "i"),
    });
    await expect(seekSegmentButton).toBeVisible();
    await seekSegmentButton.click();

    const transcriptContent = page.locator(
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

    const highlightsPane = await openHighlightsPane(page);
    const linkedRows = highlightsPane.locator("[data-highlight-id]");
    const highlightedSegments = transcriptContent.locator("[data-active-highlight-ids]");
    const beforeLinkedRowCount = await linkedRows.count();
    const beforeHighlightedCount = await highlightedSegments.count();
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      '[data-testid="document-viewport"] [data-testid="html-renderer"]',
      existingExacts
    );

    const highlightActions = page.getByRole("dialog", { name: /selection actions/i });
    await expect(highlightActions).toBeVisible({ timeout: 5_000 });

    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/api/fragments/${targetFragment.id}/highlights`)
    );
    await highlightActions.getByRole("button", { name: /^Green/ }).first().click();
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
  }) => {
    const seed = readSeededYoutubeMedia();
    await page.goto(`/media/${seed.playback_only_media_id}`);

    await expect(page.locator('iframe[title="YouTube video player"]')).toBeVisible();
    await expect(
      page.getByText("Transcript unavailable for this episode.")
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(escapeRegExp(seed.seek_segment_text), "i"),
      })
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: /open in source/i })).toHaveAttribute(
      "href",
      /youtube\.com\/watch\?v=/
    );
  });
});
