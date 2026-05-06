import { test, expect, type Page } from "@playwright/test";
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

async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  existingExacts: string[],
  {
    minLength = 20,
    maxLength = 48,
  }: { minLength?: number; maxLength?: number } = {}
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, blockedExacts, minLength, maxLength }) => {
      const container = document.querySelector(selector);
      if (!(container instanceof HTMLElement)) {
        return null;
      }

      const blocked = new Set(
        blockedExacts.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean)
      );

      const countOccurrences = (haystack: string, needle: string) => {
        let count = 0;
        let fromIndex = 0;
        while (fromIndex <= haystack.length - needle.length) {
          const matchIndex = haystack.indexOf(needle, fromIndex);
          if (matchIndex === -1) {
            break;
          }
          count += 1;
          fromIndex = matchIndex + 1;
        }
        return count;
      };

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        if (!(textNode instanceof Text)) {
          continue;
        }

        const parent = textNode.parentElement;
        if (!parent || parent.closest("[data-active-highlight-ids]")) {
          continue;
        }

        const style = window.getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        const rawText = textNode.textContent ?? "";
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight ||
          rawText.trim().length < minLength
        ) {
          continue;
        }

        for (let start = 0; start <= rawText.length - minLength; start += 1) {
          const current = rawText[start] ?? "";
          const previous = start > 0 ? rawText[start - 1] : " ";
          if (!/\S/.test(current) || /\S/.test(previous)) {
            continue;
          }

          for (
            let end = Math.min(rawText.length, start + maxLength);
            end >= start + minLength;
            end -= 1
          ) {
            const last = rawText[end - 1] ?? "";
            const next = end < rawText.length ? rawText[end] : " ";
            if (!/\S/.test(last) || (/\w/.test(last) && /\w/.test(next))) {
              continue;
            }

            const rawCandidate = rawText.slice(start, end);
            if (countOccurrences(rawText, rawCandidate) !== 1) {
              continue;
            }

            const normalizedCandidate = rawCandidate.replace(/\s+/g, " ").trim();
            if (normalizedCandidate.length < minLength || blocked.has(normalizedCandidate)) {
              continue;
            }

            const selection = window.getSelection();
            if (!selection) {
              return null;
            }

            const range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, end);
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
            return selection.toString().replace(/\s+/g, " ").trim();
          }
        }
      }

      return null;
    },
    {
      selector: containerSelector,
      blockedExacts: existingExacts,
      minLength,
      maxLength,
    }
  );

  expect(selected).toBeTruthy();
  if (!selected) {
    throw new Error(`Expected to select visible text in ${containerSelector}.`);
  }
  return selected;
}

test.describe("youtube transcript media @legacy-synthetic", () => {
  test("transcript-ready youtube flow renders embed, seeks by transcript click, and keeps fallback source action", async ({
    page,
  }) => {
    const seed = readSeededYoutubeMedia();
    const expectedStartSeconds = Math.floor(seed.seek_segment_start_ms / 1000);

    await page.goto(`/media/${seed.media_id}`);

    const playerFrame = page.locator('iframe[title="YouTube video player"]');
    await expect(playerFrame).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);

    await expect(page.getByText("No highlights in this context.")).toBeVisible();
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

    const linkedRows = page.locator("[data-highlight-id]");
    const highlightedSegments = transcriptContent.locator("[data-active-highlight-ids]");
    const beforeLinkedRowCount = await linkedRows.count();
    const beforeHighlightedCount = await highlightedSegments.count();
    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      '[data-testid="document-viewport"] [data-testid="html-renderer"]',
      existingExacts
    );

    const highlightActions = page.getByRole("dialog", { name: /highlight actions/i });
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
    if (beforeLinkedRowCount === 0) {
      await expect(page.getByText("No highlights in this context.")).toHaveCount(0);
    }

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
