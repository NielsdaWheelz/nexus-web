import { expect, test } from "@playwright/test";
import path from "node:path";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import {
  cleanupRealMediaHighlight,
  createFragmentHighlightThroughVisibleSelection,
  expectRealMediaEvidenceNeedle,
  expectVisibleTextEvidenceHighlight,
  FRESH_REAL_MEDIA_FIXTURES,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  uploadFreshRealMediaFileThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media real EPUB opens from upload-backed media and projects evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const query = FRESH_REAL_MEDIA_FIXTURES.epubMobyDickOld.query;
  const needle = FRESH_REAL_MEDIA_FIXTURES.epubMobyDickOld.needle;
  const artifactPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "python",
    "tests",
    "fixtures",
    "epub",
    "moby-dick-old.epub",
  );

  const upload = await uploadFreshRealMediaFileThroughUi({
    page,
    artifactPath,
    filename: "moby-dick-old-real-media-fresh.epub",
    mimeType: "application/epub+zip",
    expectedSha256: FRESH_REAL_MEDIA_FIXTURES.epubMobyDickOld.sha256,
    seededMediaId: seed.fixtures.epub.media_id,
    seededSha256: seed.fixtures.epub.artifact_sha256,
    artifactSalt: "upload-epub",
  });
  const mediaId = upload.media_id;

  let savedHighlightId: string | null = null;
  let productError: unknown = null;
  try {
    const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
    expect(
      mediaResponse.ok(),
      `EPUB media ${mediaId} should be readable`,
    ).toBeTruthy();
    const media = await mediaResponse.json();
    expect(media.data.kind).toBe("epub");
    expect(media.data.retrieval_status).toBe("ready");

    const fileResponse = await page.request.get(`/api/media/${mediaId}/file`);
    expect(
      fileResponse.ok(),
      `EPUB media ${mediaId} should expose its real file`,
    ).toBeTruthy();
    expect((await fileResponse.json()).data.url).toBeTruthy();

    const search = await searchRealMediaEvidenceThroughUi(page, query, "epub");
    let result = search.results.find(
      (item: { type: string; source: { media_id: string } }) =>
        item.type === "content_chunk" &&
        item.source.media_id === mediaId &&
        JSON.stringify(item).toLowerCase().includes(needle.toLowerCase()),
    );
    let resolver: { data: unknown } | null = null;
    if (result) {
      const resolverResponse = await page.request.get(
        `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
      );
      expect(resolverResponse.ok()).toBeTruthy();
      resolver = await resolverResponse.json();
    } else {
      for (const item of search.results) {
        if (item.type !== "content_chunk" || item.source.media_id !== mediaId) {
          continue;
        }
        const resolverResponse = await page.request.get(
          `/api/media/${mediaId}/evidence/${item.evidence_span_ids[0]}`,
        );
        expect(resolverResponse.ok()).toBeTruthy();
        const candidateResolver = await resolverResponse.json();
        if (
          JSON.stringify({ result: item, resolver: candidateResolver })
            .toLowerCase()
            .includes(needle.toLowerCase())
        ) {
          result = item;
          resolver = candidateResolver;
          break;
        }
      }
    }
    expect(result, "real EPUB should return indexed evidence").toBeTruthy();
    if (!result) {
      throw new Error(`real EPUB visible search did not return ${mediaId}`);
    }
    if (!resolver) {
      throw new Error("real EPUB evidence resolver did not return the pinned fixture needle");
    }
    expectRealMediaEvidenceNeedle(
      { result, resolver },
      needle,
      "real EPUB evidence should contain the pinned fixture needle",
    );

    const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
    await expect(
      resultLink,
      "real EPUB should render a visible search result",
    ).toBeVisible();
    const visibleHref = await resultLink.getAttribute("href");
    await resultLink.click();
    await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
    await expect(page.locator("body")).not.toContainText(
      /not found|failed to load/i,
    );
    await expectVisibleTextEvidenceHighlight(page);

    const savedHighlight = await createFragmentHighlightThroughVisibleSelection(
      page,
      mediaId,
      '[data-testid="html-renderer"]',
    );
    savedHighlightId = savedHighlight.id;

    writeRealMediaTrace(testInfo, "real-epub-upload-trace.json", {
      fixture_id: "epub-moby-dick-old",
      upload,
      media_id: mediaId,
      query,
      needle,
      search_api_url: search.api_url,
      search_result: result,
      visible_result_href: visibleHref,
      resolver: resolver.data,
      saved_highlight: savedHighlight,
      browser_url: page.url(),
    });
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (savedHighlightId) {
      try {
        await cleanupRealMediaHighlight(page, savedHighlightId, null);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await deleteE2eResource(
        page.request,
        `/api/media/${mediaId}`,
        "real EPUB upload media",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwE2eCleanupFailures("real EPUB upload", productError, cleanupErrors);
  }
});
