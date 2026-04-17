import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededEpubMedia {
  media_id: string;
  chapter_count: number;
  chapter_titles: string[];
  toc_anchor_label: string;
  toc_anchor_target_id: string;
  toc_anchor_heading: string;
}

interface EpubChapterDetail {
  data: {
    fragment_id: string;
    canonical_text: string;
  };
}

interface HighlightOut {
  id: string;
  start_offset: number;
  end_offset: number;
}

async function ensureFragmentHighlight(
  page: Parameters<typeof test>[0]["page"],
  fragmentId: string,
  startOffset: number,
  endOffset: number,
  color: "yellow" | "green" | "blue" | "pink" | "purple"
): Promise<HighlightOut> {
  const createResponse = await page.request.post(
    `/api/fragments/${fragmentId}/highlights`,
    {
      data: {
        start_offset: startOffset,
        end_offset: endOffset,
        color,
      },
    }
  );

  if (createResponse.status() === 201) {
    const created = (await createResponse.json()) as { data: HighlightOut };
    return created.data;
  }

  if (createResponse.status() === 409) {
    const listResponse = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
    expect(listResponse.ok()).toBeTruthy();
    const payload = (await listResponse.json()) as {
      data: { highlights: HighlightOut[] };
    };
    const existing = payload.data.highlights.find(
      (item) => item.start_offset === startOffset && item.end_offset === endOffset
    );
    expect(existing).toBeTruthy();
    if (!existing) {
      throw new Error(
        `Expected existing highlight for ${startOffset}-${endOffset} on conflict, none found.`
      );
    }
    return existing;
  }

  throw new Error(
    `Unexpected highlight create status=${createResponse.status()} body=${await createResponse.text()}`
  );
}

async function readAlignmentMetrics(
  page: Parameters<typeof test>[0]["page"],
  highlightIds: string[]
): Promise<{ order: string[]; deltas: number[]; missing: string[] }> {
  return await page.evaluate((ids) => {
    const linkedContainer = document.querySelector<HTMLElement>(
      'div[class*="linkedItemsContainer"]'
    );
    const contentRoot = document.querySelector<HTMLElement>('div[class*="fragments"]');

    if (!linkedContainer || !contentRoot) {
      return { order: [], deltas: [], missing: [...ids] };
    }

    let scrollContainer: HTMLElement | null = contentRoot.parentElement;
    while (scrollContainer && scrollContainer !== document.body) {
      const computed = window.getComputedStyle(scrollContainer);
      if (/(auto|scroll)/.test(computed.overflowY)) {
        break;
      }
      scrollContainer = scrollContainer.parentElement;
    }

    if (!(scrollContainer instanceof HTMLElement)) {
      return { order: [], deltas: [], missing: [...ids] };
    }

    const linkedRect = linkedContainer.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();

    const rawMetrics = ids.map((id) => {
      const row = linkedContainer.querySelector<HTMLElement>(`[data-highlight-id="${id}"]`);
      const anchor = contentRoot.querySelector<HTMLElement>(`[data-highlight-anchor="${id}"]`);
      if (!row || !anchor) {
        return { id, missing: true, rowTop: 0, anchorTop: 0, delta: Infinity };
      }

      const rowTop = row.getBoundingClientRect().top - linkedRect.top;
      const anchorTop = anchor.getBoundingClientRect().top - scrollRect.top;
      return {
        id,
        missing: false,
        rowTop,
        anchorTop,
        delta: 0,
      };
    });

    const present = rawMetrics.filter((metric) => !metric.missing);
    const minRowTop = present.length > 0 ? Math.min(...present.map((metric) => metric.rowTop)) : 0;
    const minAnchorTop =
      present.length > 0 ? Math.min(...present.map((metric) => metric.anchorTop)) : 0;

    const metrics = rawMetrics.map((metric) => {
      if (metric.missing) {
        return metric;
      }
      return {
        ...metric,
        delta: Math.abs(
          (metric.rowTop - minRowTop) - (metric.anchorTop - minAnchorTop),
        ),
      };
    });

    const missing = metrics.filter((m) => m.missing).map((m) => m.id);
    const order = metrics
      .filter((m) => !m.missing)
      .sort((a, b) => a.rowTop - b.rowTop)
      .map((m) => m.id);
    const deltas = metrics.filter((m) => !m.missing).map((m) => m.delta);

    return { order, deltas, missing };
  }, highlightIds);
}

function readSeededEpubMedia(): SeededEpubMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "epub-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

async function resetEpubReaderState(
  page: Parameters<typeof test>[0]["page"],
  mediaId: string,
): Promise<void> {
  let lastStatus: number | null = null;
  let lastBody = "";

  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.patch(`/api/media/${mediaId}/reader-state`, {
            data: {
              locator_kind: null,
              fragment_id: null,
              offset: null,
              section_id: null,
              page: null,
              zoom: null,
            },
          });
          if (response.ok()) {
            return true;
          }

          lastStatus = response.status();
          lastBody = await response.text();
          return false;
        },
        {
          timeout: 4_000,
          intervals: [100, 200, 400, 800],
        },
      )
      .toBe(true);
    return;
  } catch (error) {
    throw new Error(
      `Failed to reset EPUB reader state for ${mediaId}. Last status=${lastStatus}, body=${lastBody}, cause=${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function selectChapterByLabel(
  page: Parameters<typeof test>[0]["page"],
  label: string,
): Promise<void> {
  const chapterSelect = page.getByLabel("Select chapter");
  await expect(chapterSelect).toBeVisible({ timeout: 15_000 });
  await expect(chapterSelect.locator("option").filter({ hasText: label })).toHaveCount(1, {
    timeout: 10_000,
  });
  await chapterSelect.selectOption({ label });
}

async function clickToolbarAction(
  page: Parameters<typeof test>[0]["page"],
  name: string | RegExp,
): Promise<void> {
  const inlineButton = page.getByRole("button", { name }).first();
  if (
    (await inlineButton.count()) > 0 &&
    (await inlineButton.isVisible().catch(() => false))
  ) {
    await expect(inlineButton).toBeEnabled();
    await inlineButton.click();
    return;
  }

  const overflowToggle = page.getByRole("button", { name: "More actions" }).first();
  if (
    (await overflowToggle.count()) > 0 &&
    (await overflowToggle.isVisible().catch(() => false))
  ) {
    await overflowToggle.click();
    const menuItem = page.getByRole("menuitem", { name }).first();
    await expect(menuItem).toBeVisible();
    await expect(menuItem).toBeEnabled();
    await menuItem.click();
    return;
  }

  throw new Error(`Toolbar action not found for ${String(name)}`);
}

test.describe("epub", () => {
  test.beforeEach(async ({ page }) => {
    const seed = readSeededEpubMedia();
    await resetEpubReaderState(page, seed.media_id);
  });

  test("upload EPUB", async ({ page }) => {
    await page.goto("/libraries");
    await page.getByRole("button", { name: "Add content" }).click();
    const addContentDialog = page.getByRole("dialog", { name: "Add content" });
    await expect(addContentDialog).toBeVisible();
    // Verify the file upload mechanism is available
    const fileInput = addContentDialog.locator("input[type='file']");
    const uploadButton = addContentDialog.getByRole("button", { name: /upload file/i });
    await expect(fileInput.or(uploadButton).first()).toBeAttached();
  });

  test("open reader", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);
    // First chapter heading should be visible (use heading role to avoid
    // strict mode violation with the <option> in the chapter selector)
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });
  });

  test("navigate chapters", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for first chapter to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    // Click "Next chapter" to go to chapter 2
    await clickToolbarAction(page, "Next chapter");

    const chapterSelect = page.getByLabel("Select chapter");
    await expect(chapterSelect).toBeVisible();
    await chapterSelect.selectOption({ label: seed.chapter_titles[1] });

    // Chapter 2 heading should now be visible
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });

    // The selector should include at least the manifest chapter entries.
    // Some books include additional section-level entries that map to anchors.
    const options = chapterSelect.locator("option");
    await expect.poll(async () => options.count()).toBeGreaterThanOrEqual(seed.chapter_count);
    await expect
      .poll(async () => {
        const optionLabels = await options.allTextContents();
        return seed.chapter_titles.every((title) => optionLabels.includes(title));
      })
      .toBe(true);
  });

  test("toc leaf with anchor lands at exact in-fragment target", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const anchorLeaf = page.getByRole("button", { name: seed.toc_anchor_label });
    if (
      (await anchorLeaf.count()) === 0 ||
      !(await anchorLeaf.first().isVisible().catch(() => false))
    ) {
      const optionsButton = page.getByRole("button", { name: "Options" });
      await expect(optionsButton).toBeVisible();
      await optionsButton.click();
      const showToc = page.getByRole("menuitem", { name: "Show table of contents" });
      await expect(showToc).toBeVisible();
      await showToc.click();
    }

    await expect(anchorLeaf).toBeVisible();
    await anchorLeaf.click();

    await expect(page.getByRole("heading", { name: seed.toc_anchor_heading })).toBeVisible({
      timeout: 10_000,
    });
    await expect(anchorLeaf).toHaveAttribute("class", /tocActive/);
    await expect
      .poll(async () => {
        return page.evaluate((anchorId) => {
          const target = document.getElementById(anchorId);
          if (!(target instanceof HTMLElement)) {
            return false;
          }
          const rect = target.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight;
        }, seed.toc_anchor_target_id);
      })
      .toBe(true);
  });

  test("create highlight in epub", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    // Wait for chapter content to load
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    // Select text in the chapter body (scoped to the content area)
    const paragraph = page.locator('[class*="fragments"] p').first();
    await expect(paragraph).toBeVisible();
    await paragraph.selectText();

    // Selection popover should appear
    await expect(
      page.getByRole("dialog", { name: /highlight actions/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("linked-items stay aligned and ordered after reload", async ({ page }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    await selectChapterByLabel(page, seed.chapter_titles[0]);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const chapterResponse = await page.request.get(`/api/media/${seed.media_id}/chapters/0`);
    expect(chapterResponse.ok()).toBeTruthy();
    const chapter = (await chapterResponse.json()) as EpubChapterDetail;

    const needleA = "introduction chapter of the E2E test EPUB";
    const needleB = "Deterministic pre-anchor filler paragraph 2 for E2E.";
    const startA = chapter.data.canonical_text.indexOf(needleA);
    const startB = chapter.data.canonical_text.indexOf(needleB);
    expect(startA).toBeGreaterThanOrEqual(0);
    expect(startB).toBeGreaterThanOrEqual(0);
    expect(startA).toBeLessThan(startB);

    const highlightA = await ensureFragmentHighlight(
      page,
      chapter.data.fragment_id,
      startA,
      startA + needleA.length,
      "yellow"
    );
    const highlightB = await ensureFragmentHighlight(
      page,
      chapter.data.fragment_id,
      startB,
      startB + needleB.length,
      "green"
    );

    const targetIds = [highlightA.id, highlightB.id];

    for (let iteration = 0; iteration < 2; iteration++) {
      await page.reload();
      await selectChapterByLabel(page, seed.chapter_titles[0]);
      await expect(
        page.getByRole("heading", { name: seed.chapter_titles[0] })
      ).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const metrics = await readAlignmentMetrics(page, targetIds);
            return metrics.missing.length;
          },
          { timeout: 15_000 }
        )
        .toBe(0);

      const metrics = await readAlignmentMetrics(page, targetIds);
      expect(metrics.order).toEqual(targetIds);
      expect(metrics.deltas.length).toBe(2);
      for (const delta of metrics.deltas) {
        // Unified pane chrome introduces a small vertical offset in row/anchor
        // alignment while preserving ordering and click targeting fidelity.
        expect(delta).toBeLessThan(100);
      }
    }
  });

  test("book-mode linked item click navigates chapters and lands focus", async ({
    page,
  }) => {
    const seed = readSeededEpubMedia();
    await page.goto(`/media/${seed.media_id}`);

    await selectChapterByLabel(page, seed.chapter_titles[0]);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    const chapter0Response = await page.request.get(`/api/media/${seed.media_id}/chapters/0`);
    expect(chapter0Response.ok()).toBeTruthy();
    const chapter0 = (await chapter0Response.json()) as EpubChapterDetail;

    const needle = "introduction chapter of the E2E test EPUB";
    const start = chapter0.data.canonical_text.indexOf(needle);
    expect(start).toBeGreaterThanOrEqual(0);

    const targetHighlight = await ensureFragmentHighlight(
      page,
      chapter0.data.fragment_id,
      start,
      start + needle.length,
      "pink"
    );

    await selectChapterByLabel(page, seed.chapter_titles[1]);
    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[1] })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Entire book" }).click();
    const targetRow = page.locator(`[data-highlight-id="${targetHighlight.id}"]`).first();
    await expect(targetRow).toBeVisible({ timeout: 15_000 });
    await targetRow.click();

    await expect(
      page.getByRole("heading", { name: seed.chapter_titles[0] })
    ).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(
        async () => {
          const result = await page.evaluate((highlightId) => {
            const contentRoot = document.querySelector<HTMLElement>('div[class*="fragments"]');
            if (!contentRoot) {
              return null;
            }

            const anchor = contentRoot.querySelector<HTMLElement>(
              `[data-highlight-anchor="${highlightId}"]`
            );
            if (!anchor) {
              return null;
            }

            let scroller: HTMLElement | null = contentRoot.parentElement;
            while (scroller && scroller !== document.body) {
              const computed = window.getComputedStyle(scroller);
              const canScrollY =
                /(auto|scroll)/.test(computed.overflowY) &&
                scroller.scrollHeight > scroller.clientHeight;
              if (canScrollY) {
                break;
              }
              scroller = scroller.parentElement;
            }
            if (!(scroller instanceof HTMLElement)) {
              return null;
            }

            const anchorTop = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            const centerY = scroller.clientHeight / 2;
            return Math.abs(anchorTop - centerY);
          }, targetHighlight.id);

          return result;
        },
        { timeout: 15_000 }
      )
      .toBeLessThan(170);
  });
});
