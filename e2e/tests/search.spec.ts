import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

interface NonPdfSeed {
  media_id: string;
  quote_exact: string;
}

interface PdfSeed {
  media_id: string;
}

interface EpubSeed {
  media_id: string;
  toc_anchor_heading: string;
}

interface YoutubeSeed {
  media_id: string;
  seek_segment_text: string;
  seek_segment_start_ms: number;
}

type SeedName =
  | "non-pdf-media.json"
  | "pdf-media.json"
  | "epub-media.json"
  | "youtube-media.json";

const RESULT_TYPE_LABELS = [
  "Authors",
  "Media",
  "Podcasts",
  "Evidence",
  "Pages",
  "Notes",
  "Messages",
];

function readSeed<T>(name: SeedName): T {
  const seedPath = path.join(__dirname, "..", ".seed", name);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function submitSearch(page: Page): Locator {
  return page.getByRole("button", { name: "Search", exact: true });
}

async function searchFor(page: Page, query: string): Promise<void> {
  await page.goto("/search");
  const searchInput = page.getByPlaceholder("Search your Nexus content...");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(query);
  await submitSearch(page).click();
}

async function setOnlyContentChunkFilter(page: Page): Promise<void> {
  const resultTypes = page.getByRole("group", { name: "Result types" });
  for (const label of RESULT_TYPE_LABELS) {
    const checkbox = resultTypes.getByRole("checkbox", { name: label });
    if ((await checkbox.count()) === 0) {
      continue;
    }
    if (label === "Evidence") {
      await checkbox.check();
    } else {
      await checkbox.uncheck();
    }
  }
}

async function clickCitationResult(
  page: Page,
  {
    mediaId,
    query,
    resultText,
  }: {
    mediaId: string;
    query: string;
    resultText?: RegExp;
  }
): Promise<URL> {
  await page.goto("/search");
  await setOnlyContentChunkFilter(page);

  const searchInput = page.getByPlaceholder("Search your Nexus content...");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(query);
  await submitSearch(page).click();

  const citationLink = page.locator(`a[href^="/media/${mediaId}?evidence="]`).first();
  await expect(citationLink).toBeVisible({ timeout: 15_000 });
  await expect(citationLink).toContainText(resultText ?? new RegExp(escapeRegExp(query), "i"));

  await citationLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${escapeRegExp(mediaId)}\\?`));

  const url = new URL(page.url());
  expect(url.pathname).toBe(`/media/${mediaId}`);
  expect(url.searchParams.get("evidence")).toBeTruthy();
  return url;
}

async function expectVisibleEvidenceHighlight(page: Page, expectedText: string): Promise<void> {
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"]').first()
  ).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(".hl-evidence").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(new RegExp(escapeRegExp(expectedText), "i")).first()).toBeVisible();
}

test.describe("search @legacy-synthetic", () => {
  test("search returns results", async ({ page }) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    await searchFor(page, seed.quote_exact);

    await expect(page.locator("a[href^='/media/']").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("no-results behavior", async ({ page }) => {
    await searchFor(page, "xyznonexistent12345");

    await expect(page.getByText("No results found.")).toBeVisible();
  });

  test("explicit empty type filters return no results", async ({ page }) => {
    await page.goto("/search");
    const searchInput = page.getByPlaceholder("Search your Nexus content...");
    await expect(searchInput).toBeVisible();

    const resultTypes = page.getByRole("group", { name: "Result types" });
    for (const label of RESULT_TYPE_LABELS) {
      const checkbox = resultTypes.getByRole("checkbox", { name: label });
      if ((await checkbox.count()) > 0) {
        await checkbox.uncheck();
      }
    }

    await searchInput.fill("e2e non-pdf");
    await submitSearch(page).click();

    await expect(page.getByText("No results found.")).toBeVisible();
  });

  test("note rows surface quote context before metadata", async ({ page }) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    await searchFor(page, "seeded note for non-pdf linked-items e2e");

    await expect(
      page.getByRole("link", { name: new RegExp(escapeRegExp(seed.quote_exact), "i") }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("web citation search result opens the evidence highlight", async ({ page }) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    const url = await clickCitationResult(page, {
      mediaId: seed.media_id,
      query: seed.quote_exact,
    });

    expect(url.searchParams.get("fragment")).toBeTruthy();
    await expectVisibleEvidenceHighlight(page, seed.quote_exact);
  });

  test("EPUB citation search result opens the evidence highlight", async ({ page }) => {
    const seed = readSeed<EpubSeed>("epub-media.json");
    const query = "Anchor target landing paragraph";

    const url = await clickCitationResult(page, {
      mediaId: seed.media_id,
      query,
      resultText: /Anchor target landing/i,
    });

    expect(url.searchParams.get("loc") ?? url.searchParams.get("fragment")).toBeTruthy();
    await expectVisibleEvidenceHighlight(page, query);
    await expect(page.getByRole("heading", { name: seed.toc_anchor_heading })).toBeVisible();
  });

  test("PDF citation search result opens the cited page", async ({ page }) => {
    const seed = readSeed<PdfSeed>("pdf-media.json");
    const query = "This file is generated";

    const url = await clickCitationResult(page, {
      mediaId: seed.media_id,
      query,
      resultText: /generated by/i,
    });

    const pageNumber = url.searchParams.get("page");
    expect(pageNumber).toBeTruthy();
    await expect(page.getByTestId(`pdf-page-surface-${pageNumber}`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/E2E PDF signed-url expiry seed/i).first()).toBeVisible();
  });

  test("YouTube transcript citation search result opens and seeks to evidence", async ({
    page,
  }) => {
    const seed = readSeed<YoutubeSeed>("youtube-media.json");

    const url = await clickCitationResult(page, {
      mediaId: seed.media_id,
      query: seed.seek_segment_text,
      resultText: /S8 E2E segment beta seek target/i,
    });

    expect(url.searchParams.get("t_start_ms")).toBe(String(seed.seek_segment_start_ms));
    await expectVisibleEvidenceHighlight(page, seed.seek_segment_text.replace(/\.$/, ""));

    const playerFrame = page.locator('iframe[title="YouTube video player"]');
    await expect(playerFrame).toBeVisible();
    await expect
      .poll(async () => (await playerFrame.getAttribute("src")) ?? "", { timeout: 10_000 })
      .toContain(`start=${Math.floor(seed.seek_segment_start_ms / 1000)}`);
  });
});
