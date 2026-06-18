import { expect, test } from "@playwright/test";
import { activeWorkspacePane } from "../workspace";
import {
  expectActivePaneHasNoLoadError,
  expectCurrentMediaEvidenceUrl,
  expectVisiblePdfEvidenceHighlight,
  expectVisibleTextEvidenceHighlight,
  openTranscriptEvidenceSegment,
  readRealMediaSeed,
  realMediaEvidenceResultLink,
  searchRealMediaEvidenceThroughUi,
  type RealMediaContentKind,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media search returns resolver-backed evidence for every configured media kind", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const media: Array<[string, string, string, RealMediaContentKind]> = [
    ["pdf", seed.fixtures.pdf.media_id, seed.fixtures.pdf.query, "pdf"],
    ["epub", seed.fixtures.epub.media_id, seed.fixtures.epub.query, "epub"],
    [
      "web article",
      seed.fixtures.web.media_id,
      seed.fixtures.web.query,
      "web_article",
    ],
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
    const body = await searchRealMediaEvidenceThroughUi(
      page,
      query,
      contentKind,
    );
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
    const evidenceSpanId = result.evidence_span_ids[0];
    expect(result.activation.href).toBe(
      `/media/${mediaId}#evidence-${evidenceSpanId}`,
    );
    expect("deep_link" in result).toBe(false);
    const resolverResponse = await page.request.get(
      `/api/media/${mediaId}/evidence/${evidenceSpanId}`,
    );
    expect(resolverResponse.ok()).toBeTruthy();
    const resolver = await resolverResponse.json();

    const resultLink = realMediaEvidenceResultLink(
      page,
      mediaId,
      evidenceSpanId,
    );
    await expect(
      resultLink,
      `${kind} should render a visible evidence result`,
    ).toBeVisible();
    const visibleHref = await resultLink.getAttribute("href");
    if (!visibleHref) {
      throw new Error(
        `${kind} evidence result for ${mediaId} did not expose a href`,
      );
    }
    await resultLink.click();
    await expectCurrentMediaEvidenceUrl(page, mediaId, evidenceSpanId);
    await expectActivePaneHasNoLoadError(page);
    if (contentKind === "pdf") {
      expect(resolver.data.resolver.status).toBe("resolved");
      await expectVisiblePdfEvidenceHighlight(page, evidenceSpanId);
    } else if (contentKind === "video" || contentKind === "podcast_episode") {
      await openTranscriptEvidenceSegment(page, query, visibleHref);
      await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);
    } else {
      await expectVisibleTextEvidenceHighlight(page, evidenceSpanId);
    }
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

  const noResultsQuery = "qzxqzxqzxqzx missingterm";
  const noResults = await searchRealMediaEvidenceThroughUi(
    page,
    noResultsQuery,
    "web_article",
  );
  expect(noResults.results).toEqual([]);
  await expect(
    activeWorkspacePane(page).getByText("No results found."),
  ).toBeVisible();

  writeRealMediaTrace(testInfo, "real-media-search-evidence-trace.json", {
    results: traces,
    no_results: {
      media_id: seed.fixtures.web.media_id,
      query: noResultsQuery,
      result_count: noResults.results.length,
    },
  });
});
