import { expect, test, type Page } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

const CONTENT_KIND_LABELS = {
  epub: "EPUBs",
  pdf: "PDFs",
  podcast_episode: "Episodes",
  video: "Videos",
  web_article: "Articles",
} as const;

type ContentKind = keyof typeof CONTENT_KIND_LABELS;

interface SearchResult {
  type: string;
  source: { media_id: string };
  context_ref: { type: string; evidence_span_ids: string[] };
  evidence_span_ids: string[];
  deep_link: string;
}

interface SearchResponseBody {
  results: SearchResult[];
}

async function searchEvidenceThroughUi(
  page: Page,
  query: string,
  contentKind: ContentKind,
): Promise<SearchResponseBody> {
  await page.goto(`/search?types=content_chunk&content_kinds=${contentKind}`);
  await expect(
    page.getByRole("group", { name: "Result types" }).getByLabel("Evidence"),
  ).toBeChecked();
  await expect(
    page
      .getByRole("group", { name: "Content kinds" })
      .getByLabel(CONTENT_KIND_LABELS[contentKind]),
  ).toBeChecked();

  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "GET") {
      return false;
    }
    const url = new URL(response.url());
    return (
      url.pathname === "/api/search" &&
      url.searchParams.get("q") === query &&
      url.searchParams.get("types") === "content_chunk" &&
      url.searchParams.get("content_kinds") === contentKind
    );
  });
  await page.getByLabel("Search content").fill(query);
  await page.getByRole("button", { name: "Search" }).click();
  const response = await responsePromise;
  expect(response.ok(), `visible search for ${contentKind} should succeed`).toBeTruthy();
  return response.json() as Promise<SearchResponseBody>;
}

test("@real-media search returns resolver-backed evidence for every configured media kind", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const media: Array<[string, string, string, ContentKind]> = [
    ["pdf", seed.fixtures.pdf.media_id, seed.fixtures.pdf.query, "pdf"],
    ["epub", seed.fixtures.epub.media_id, seed.fixtures.epub.query, "epub"],
    ["web article", seed.fixtures.web.media_id, seed.fixtures.web.query, "web_article"],
    ["video", seed.fixtures.video.media_id, seed.fixtures.video.query, "video"],
    [
      "podcast episode",
      seed.fixtures.podcast.media_id,
      seed.fixtures.podcast.query,
      "podcast_episode",
    ],
  ];
  const traces = [];

  for (const [kind, mediaId, query, contentKind] of media) {
    const body = await searchEvidenceThroughUi(page, query, contentKind);
    const result = body.results.find(
      (item: { type: string; source: { media_id: string } }) =>
        item.type === "content_chunk" && item.source.media_id === mediaId,
    );
    expect(
      result,
      `${kind} search should return content_chunk evidence`,
    ).toBeTruthy();
    if (!result) {
      throw new Error(`${kind} visible search did not return ${mediaId}`);
    }
    expect(result.context_ref.type).toBe("content_chunk");
    expect(result.context_ref.evidence_span_ids.length).toBeGreaterThan(0);
    expect(result.evidence_span_ids).toEqual(
      result.context_ref.evidence_span_ids,
    );
    expect(result.deep_link).toContain(`/media/${mediaId}?`);
    const resolverResponse = await page.request.get(
      `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
    );
    expect(resolverResponse.ok()).toBeTruthy();
    const resolver = await resolverResponse.json();

    const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
    await expect(resultLink, `${kind} should render a visible evidence result`).toBeVisible();
    const visibleHref = await resultLink.getAttribute("href");
    await resultLink.click();
    await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
    await expect(page.locator("body")).not.toContainText(
      /not found|failed to load/i,
    );
    await expect(
      page
        .locator(
          '[data-testid^="pdf-highlight-evidence-"], [data-highlight-anchor^="evidence-"], .hl-evidence',
        )
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    traces.push({
      kind,
      media_id: mediaId,
      query,
      content_kind: contentKind,
      search_result: result,
      resolver: resolver.data,
      visible_result_href: visibleHref,
      browser_url: page.url(),
    });
  }

  const noResults = await searchEvidenceThroughUi(
    page,
    "zzzz-real-media-no-result",
    "web_article",
  );
  expect(noResults.results).toEqual([]);
  await expect(page.getByText("No results found.")).toBeVisible();

  writeRealMediaTrace(testInfo, "real-media-search-evidence-trace.json", {
    results: traces,
    no_results: {
      media_id: seed.fixtures.web.media_id,
      query: "zzzz-real-media-no-result",
      result_count: noResults.results.length,
    },
  });
});
