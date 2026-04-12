import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface SeededNonPdfMedia {
  media_id: string;
  fragment_id: string;
  quote_highlight_id: string;
  focus_highlight_id: string;
  quote_exact: string;
  focus_exact: string;
}

function readSeededNonPdfMedia(): SeededNonPdfMedia {
  const seedPath = path.join(process.cwd(), ".seed", "non-pdf-media.json");
  const raw = readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeededNonPdfMedia;

  const requiredFields: Array<keyof SeededNonPdfMedia> = [
    "media_id",
    "fragment_id",
    "quote_highlight_id",
    "focus_highlight_id",
    "quote_exact",
    "focus_exact",
  ];
  for (const field of requiredFields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Invalid seeded non-PDF metadata field "${field}" at ${seedPath}`);
    }
  }

  return parsed;
}

function linkedItemRowByText(text: string): string {
  return `[class*="linkedItemRow"]:has-text("${text}")`;
}

function distanceOutsideViewport(top: number, viewportHeight: number): number {
  if (top < 0) {
    return Math.abs(top);
  }
  if (top > viewportHeight) {
    return top - viewportHeight;
  }
  return 0;
}

async function readQueuedQuoteRoute(
  page: Parameters<typeof test>[0]["page"],
  highlightId: string
): Promise<string | null> {
  return page.evaluate((targetHighlightId) => {
    const isQuoteToChatRoute = (pathname: string, attachType: string | null, attachId: string | null) =>
      (pathname === "/conversations/new" || pathname === "/conversations") &&
      attachType === "highlight" &&
      attachId === targetHighlightId;

    const currentWindow = window as Window & {
      __nexusPendingPaneOpenQueue?: Array<
        string | { href?: string; titleHint?: string; resourceRef?: string }
      >;
    };
    const queue = currentWindow.__nexusPendingPaneOpenQueue ?? [];
    for (const entry of queue) {
      const href =
        typeof entry === "string"
          ? entry
          : typeof entry?.href === "string"
            ? entry.href
            : null;
      if (!href) {
        continue;
      }
      try {
        const parsed = new URL(href, window.location.origin);
        if (
          isQuoteToChatRoute(
            parsed.pathname,
            parsed.searchParams.get("attach_type"),
            parsed.searchParams.get("attach_id"),
          )
        ) {
          return href;
        }
      } catch {
        continue;
      }
    }
    return null;
  }, highlightId);
}

test.describe("non-pdf linked-items", () => {
  test("row quote and row focus/scroll interactions work end-to-end", async ({ page }) => {
    const seeded = readSeededNonPdfMedia();
    const mediaUrl = `/media/${seeded.media_id}`;
    const contentPane = page.locator('div[class*="fragments"]');

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    // Use the focus-target row for quote interaction because it is guaranteed
    // to be brought into the visible linked-items pane region by this fixture.
    const focusRow = page.locator(linkedItemRowByText(seeded.focus_exact)).first();
    await expect(page.locator(linkedItemRowByText(seeded.quote_exact)).first()).toBeVisible({ timeout: 10_000 });
    await expect(focusRow).toBeVisible({ timeout: 10_000 });

    await expect(focusRow.getByText("Seeded focus note for non-PDF linked-items e2e.")).toBeVisible();
    await focusRow.hover();
    const chatButton = focusRow.getByLabel("Send to chat");
    await expect(chatButton).toBeVisible();
    const conversationTabCountBefore = await page
      .getByRole("tab", { name: /chat/i })
      .count();
    await chatButton.click();
    const chatAttachPrefix = `highlight: ${seeded.focus_highlight_id.slice(0, 8)}`;
    let quoteNavigationOutcome: "url" | "queued" | "pane" | null = null;
    await expect
      .poll(
        async () => {
          const currentUrl = new URL(page.url());
          if (
            (currentUrl.pathname === "/conversations/new" ||
              currentUrl.pathname === "/conversations") &&
            currentUrl.searchParams.get("attach_type") === "highlight" &&
            currentUrl.searchParams.get("attach_id") === seeded.focus_highlight_id
          ) {
            quoteNavigationOutcome = "url";
            return quoteNavigationOutcome;
          }
          const queuedRoute = await readQueuedQuoteRoute(page, seeded.focus_highlight_id);
          if (queuedRoute) {
            quoteNavigationOutcome = "queued";
            return quoteNavigationOutcome;
          }
          const contextChipCount = await page.getByText(chatAttachPrefix, { exact: false }).count();
          if (contextChipCount > 0) {
            quoteNavigationOutcome = "pane";
            return quoteNavigationOutcome;
          }
          const tabCount = await page.getByRole("tab", { name: /chat/i }).count();
          if (tabCount > conversationTabCountBefore) {
            quoteNavigationOutcome = "pane";
            return quoteNavigationOutcome;
          }
          return null;
        },
        { timeout: 15_000 }
      )
      .not.toBeNull();

    if (quoteNavigationOutcome === "url") {
      await expect
        .poll(() => {
          const currentUrl = new URL(page.url());
          if (
            currentUrl.pathname !== "/conversations/new" &&
            currentUrl.pathname !== "/conversations"
          ) {
            return null;
          }
          if (currentUrl.searchParams.get("attach_type") !== "highlight") {
            return null;
          }
          return currentUrl.searchParams.get("attach_id");
        })
        .toBe(seeded.focus_highlight_id);
    } else if (quoteNavigationOutcome === "queued") {
      const queuedRoute = await readQueuedQuoteRoute(page, seeded.focus_highlight_id);
      expect(queuedRoute).toBeTruthy();
      if (queuedRoute) {
        await page.goto(queuedRoute);
      }
      await expect
        .poll(() => {
          const currentUrl = new URL(page.url());
          if (
            currentUrl.pathname !== "/conversations/new" &&
            currentUrl.pathname !== "/conversations"
          ) {
            return null;
          }
          if (currentUrl.searchParams.get("attach_type") !== "highlight") {
            return null;
          }
          return currentUrl.searchParams.get("attach_id");
        })
        .toBe(seeded.focus_highlight_id);
    } else {
      await expect(page.getByText(chatAttachPrefix, { exact: false })).toBeVisible({
        timeout: 10_000,
      });
    }

    await page.goto(mediaUrl);
    await expect(contentPane).toBeVisible({ timeout: 10_000 });

    const focusedSegment = contentPane
      .locator(`[data-active-highlight-ids~="${seeded.focus_highlight_id}"]`)
      .first();
    const readerPaneContent = page
      .locator('[data-pane-content="true"]')
      .filter({ has: contentPane })
      .first();
    await expect(readerPaneContent).toBeVisible({ timeout: 10_000 });
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const readFocusedSegmentTop = async () =>
      focusedSegment.evaluate((element) =>
        Math.round((element as HTMLElement).getBoundingClientRect().top),
      );

    // Normalize to a deterministic off-screen starting state for scroll assertions.
    await readerPaneContent.evaluate((element) => {
      (element as HTMLElement).scrollTop = (element as HTMLElement).scrollHeight;
    });
    let topBefore = await readFocusedSegmentTop();
    if (topBefore >= 0 && topBefore <= viewportHeight) {
      await readerPaneContent.evaluate((element) => {
        (element as HTMLElement).scrollTop = 0;
      });
      topBefore = await readFocusedSegmentTop();
    }
    const distanceBefore = distanceOutsideViewport(topBefore, viewportHeight);

    const focusRowAgain = page.locator(linkedItemRowByText(seeded.focus_exact)).first();
    await expect(focusRowAgain).toBeVisible({ timeout: 10_000 });
    await focusRowAgain.click();

    await expect
      .poll(
        async () => {
          const top = await readFocusedSegmentTop();
          return top >= 0 && top <= Math.floor(viewportHeight * 0.8);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const topAfter = await readFocusedSegmentTop();
    const distanceAfter = distanceOutsideViewport(topAfter, viewportHeight);
    if (distanceBefore > 0) {
      expect(distanceAfter).toBeLessThan(distanceBefore);
    }
    await expect(focusedSegment).toBeVisible();
    await expect(focusedSegment).toHaveClass(/hl-focused/);
  });
});
