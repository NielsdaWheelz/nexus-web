import { expect, test } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media search returns resolver-backed evidence for every configured media kind", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const media = [
    ["pdf", seed.fixtures.pdf.media_id, seed.fixtures.pdf.query],
    ["epub", seed.fixtures.epub.media_id, seed.fixtures.epub.query],
    ["web article", seed.fixtures.web.media_id, seed.fixtures.web.query],
    ["video", seed.fixtures.video.media_id, seed.fixtures.video.query],
    [
      "podcast episode",
      seed.fixtures.podcast.media_id,
      seed.fixtures.podcast.query,
    ],
  ];
  const traces = [];

  for (const [kind, mediaId, query] of media) {
    const response = await page.request.get("/api/search", {
      params: {
        q: query,
        scope: `media:${mediaId}`,
        types: "content_chunk",
        limit: "5",
      },
    });
    expect(response.ok(), `${kind} search should succeed`).toBeTruthy();
    const body = await response.json();
    const result = body.results.find(
      (item: { type: string; source: { media_id: string } }) =>
        item.type === "content_chunk" && item.source.media_id === mediaId,
    );
    expect(
      result,
      `${kind} search should return content_chunk evidence`,
    ).toBeTruthy();
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

    await page.goto(result.deep_link);
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
      search_result: result,
      resolver: resolver.data,
      browser_url: page.url(),
    });
  }

  const noResultsResponse = await page.request.get("/api/search", {
    params: {
      q: "zzzz-real-media-no-result",
      scope: `media:${seed.fixtures.web.media_id}`,
      types: "content_chunk",
      limit: "5",
    },
  });
  expect(noResultsResponse.ok()).toBeTruthy();
  const noResults = await noResultsResponse.json();
  expect(noResults.results).toEqual([]);

  writeRealMediaTrace(testInfo, "real-media-search-evidence-trace.json", {
    results: traces,
    no_results: {
      media_id: seed.fixtures.web.media_id,
      query: "zzzz-real-media-no-result",
      result_count: noResults.results.length,
    },
  });
});
