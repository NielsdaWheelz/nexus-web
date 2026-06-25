import {
  test,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

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

// The six user-facing kind chips (intent-model surface). All active by default.
const SEARCH_KIND_LABELS = [
  "Documents",
  "Notes",
  "Highlights",
  "Conversations",
  "People",
  "Web",
];

function readSeed<T>(name: SeedName): T {
  const seedPath = path.join(__dirname, "..", ".seed", name);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchFor(
  page: Page,
  testInfo: TestInfo,
  query: string,
): Promise<void> {
  await gotoSinglePaneWorkspace(
    page,
    workspaceE2eDeviceId(testInfo, "e2e-search"),
    "/search",
  );
  const searchPane = activeWorkspacePane(page);
  // Live, debounced search — no submit button; filling the box drives the query.
  const searchInput = searchPane.getByLabel("Search content");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(query);
}

async function clickCitationResult(
  page: Page,
  testInfo: TestInfo,
  {
    mediaId,
    query,
  }: {
    mediaId: string;
    query: string;
  }
): Promise<URL> {
  await gotoSinglePaneWorkspace(
    page,
    workspaceE2eDeviceId(testInfo, "e2e-search"),
    "/search",
  );

  // Evidence spans are folded into the default Documents kind; the evidence-span
  // citation row is selected by its #evidence- deep link, no type filter needed.
  const searchPane = activeWorkspacePane(page);
  const searchInput = searchPane.getByLabel("Search content");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(query);

  const citationLink = searchPane
    .locator(`a[href*="/media/${mediaId}#evidence-"]`)
    .first();
  await expect(citationLink).toBeVisible({ timeout: 15_000 });

  await citationLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${escapeRegExp(mediaId)}#evidence-`));

  const url = new URL(page.url());
  expect(url.pathname).toBe(`/media/${mediaId}`);
  expect(url.hash).toMatch(/^#evidence-/);
  return url;
}

async function expectVisibleEvidenceHighlight(page: Page, expectedText: string): Promise<void> {
  const activePane = activeWorkspacePane(page);
  await expect(
    activePane.locator('[data-highlight-anchor^="evidence-"]').first()
  ).toBeAttached({ timeout: 15_000 });
  await expect(activePane.locator(".hl-evidence").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    activePane.getByText(new RegExp(escapeRegExp(expectedText), "i")).first()
  ).toBeVisible();
}

test.describe("search", () => {
  test("search returns results", async ({ page }, testInfo) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    await searchFor(page, testInfo, seed.quote_exact);

    await expect(activeWorkspacePane(page).locator("a[href^='/media/']").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("no-results behavior", async ({ page }, testInfo) => {
    await searchFor(page, testInfo, "xyznonexistent12345");

    await expect(activeWorkspacePane(page).getByText("No results found.")).toBeVisible();
  });

  test("deselecting all kinds returns no results", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-search"),
      "/search",
    );
    const searchPane = activeWorkspacePane(page);
    const searchInput = searchPane.getByLabel("Search content");
    await expect(searchInput).toBeVisible();

    // Deselecting every kind chip is the explicit-empty case (⇒ no results, not all).
    const kinds = searchPane.getByRole("group", { name: "Result kinds" });
    await expect(async () => {
      for (const label of SEARCH_KIND_LABELS) {
        const chip = kinds.getByRole("button", {
          name: label,
          exact: true,
        });
        await expect(chip).toBeVisible();
        if ((await chip.getAttribute("aria-pressed")) === "true") {
          await chip.click();
        }
        await expect(chip).toHaveAttribute("aria-pressed", "false");
      }
    }).toPass({ timeout: 10_000 });

    await searchInput.fill("e2e non-pdf");

    await expect(searchPane.getByText("No results found.")).toBeVisible();
  });

  test("note rows surface quote context before metadata", async ({ page }, testInfo) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    await searchFor(page, testInfo, "seeded note for non-pdf linked-items e2e");

    await expect(
      activeWorkspacePane(page)
        .getByRole("link", { name: new RegExp(escapeRegExp(seed.quote_exact), "i") })
        .first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("web citation search result opens the evidence highlight", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<NonPdfSeed>("non-pdf-media.json");

    const url = await clickCitationResult(page, testInfo, {
      mediaId: seed.media_id,
      query: seed.quote_exact,
    });

    expect(url.hash).toMatch(/^#evidence-/);
    await expectVisibleEvidenceHighlight(page, seed.quote_exact);
  });

  test("EPUB citation search result opens the evidence highlight", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<EpubSeed>("epub-media.json");
    const query = "Anchor target landing paragraph";

    const url = await clickCitationResult(page, testInfo, {
      mediaId: seed.media_id,
      query,
    });

    expect(url.hash).toMatch(/^#evidence-/);
    await expectVisibleEvidenceHighlight(page, query);
    await expect(
      activeWorkspacePane(page).getByRole("heading", {
        name: seed.toc_anchor_heading,
      })
    ).toBeVisible();
  });

  test("PDF citation search result opens the cited page", async ({ page }, testInfo) => {
    const seed = readSeed<PdfSeed>("pdf-media.json");
    const query = "This file is generated";

    const url = await clickCitationResult(page, testInfo, {
      mediaId: seed.media_id,
      query,
    });

    expect(url.hash).toMatch(/^#evidence-/);
    const activePane = activeWorkspacePane(page);
    await expect(activePane.getByText(/E2E PDF signed-url expiry seed/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("YouTube transcript citation search result opens and seeks to evidence", async ({
    page,
  }, testInfo) => {
    const seed = readSeed<YoutubeSeed>("youtube-media.json");

    const url = await clickCitationResult(page, testInfo, {
      mediaId: seed.media_id,
      query: seed.seek_segment_text,
    });

    expect(url.hash).toMatch(/^#evidence-/);
    await expectVisibleEvidenceHighlight(page, seed.seek_segment_text.replace(/\.$/, ""));

    const playerFrame = activeWorkspacePane(page).locator(
      'iframe[title="YouTube video player"]'
    );
    await expect(playerFrame).toBeVisible();
    await expect
      .poll(async () => (await playerFrame.getAttribute("src")) ?? "", { timeout: 10_000 })
      .toContain(`start=${Math.floor(seed.seek_segment_start_ms / 1000)}`);
  });
});
