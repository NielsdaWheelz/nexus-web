import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

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

test.describe("youtube transcript media", () => {
  test("transcript-ready youtube flow renders embed, seeks by transcript click, and keeps fallback source action", async ({
    page,
  }) => {
    const seed = readSeededYoutubeMedia();
    const expectedStartSeconds = Math.floor(seed.seek_segment_start_ms / 1000);

    await page.goto(`/media/${seed.media_id}`);

    const playerFrame = page.locator('iframe[title="YouTube video player"]');
    await expect(playerFrame).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);

    await expect(page.getByText("No highlights yet. Select text to create one.")).toBeVisible();
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
