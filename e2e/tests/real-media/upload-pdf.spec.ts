import { expect, test } from "@playwright/test";
import path from "node:path";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import { activeWorkspacePane } from "../workspace";
import {
  cleanupRealMediaHighlight,
  createPdfHighlightThroughVisibleSelection,
  expectActivePaneHasNoLoadError,
  expectCurrentMediaEvidenceUrl,
  expectRealMediaEvidenceNeedle,
  expectVisiblePdfEvidenceHighlight,
  FRESH_REAL_MEDIA_FIXTURES,
  readRealMediaSeed,
  realMediaEvidenceResultLink,
  searchRealMediaEvidenceThroughUi,
  uploadFreshRealMediaFileThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media real PDF opens from upload-backed media and projects evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const artifactPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "python",
    "tests",
    "fixtures",
    "pdf",
    "svms.pdf",
  );
  const query = FRESH_REAL_MEDIA_FIXTURES.pdfSvms.query;
  const needle = FRESH_REAL_MEDIA_FIXTURES.pdfSvms.needle;

  const upload = await uploadFreshRealMediaFileThroughUi({
    page,
    artifactPath,
    filename: "svms-real-media-fresh.pdf",
    mimeType: "application/pdf",
    expectedSizeBytes: FRESH_REAL_MEDIA_FIXTURES.pdfSvms.sizeBytes,
    seededMediaId: seed.fixtures.pdf.media_id,
    artifactSalt: "upload-pdf",
  });
  const mediaId = upload.media_id;

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `PDF media ${mediaId} should be readable`,
  ).toBeTruthy();
  const media = await mediaResponse.json();
  expect(media.data.kind).toBe("pdf");
  expect(media.data.retrieval_status).toBe("ready");

  const fileResponse = await page.request.get(`/api/media/${mediaId}/file`);
  expect(
    fileResponse.ok(),
    `PDF media ${mediaId} should expose its real file`,
  ).toBeTruthy();
  expect((await fileResponse.json()).data.url).toBeTruthy();

  const search = await searchRealMediaEvidenceThroughUi(page, query, "pdf");
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(result, "real PDF should return indexed evidence").toBeTruthy();
  if (!result) {
    throw new Error(`real PDF visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();
  expectRealMediaEvidenceNeedle(
    { result, resolver },
    needle,
    "real PDF evidence should contain the pinned fixture needle",
  );
  const evidenceSpanId = result.evidence_span_ids[0];

  const resultLink = realMediaEvidenceResultLink(page, mediaId, evidenceSpanId);
  await expect(
    resultLink,
    "real PDF should render a visible search result",
  ).toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expectCurrentMediaEvidenceUrl(page, mediaId, evidenceSpanId);
  await expectActivePaneHasNoLoadError(page);
  expect(resolver.data.resolver.status).toBe("resolved");
  await expectVisiblePdfEvidenceHighlight(page, evidenceSpanId);
  let createdHighlightId: string | null = null;

  let productError: unknown = null;
  try {
    const savedHighlight = await createPdfHighlightThroughVisibleSelection(
      page,
      mediaId,
    );
    createdHighlightId = savedHighlight.id;
    await page.reload();
    await expect(
      activeWorkspacePane(page)
        .locator(`[data-testid^="pdf-highlight-${savedHighlight.id}-"]`)
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    writeRealMediaTrace(testInfo, "real-pdf-upload-trace.json", {
      fixture_id: "pdf-svms",
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
    if (createdHighlightId) {
      try {
        await cleanupRealMediaHighlight(page, createdHighlightId, null);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await deleteE2eResource(
        page.request,
        `/api/media/${mediaId}`,
        "real PDF upload media",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwE2eCleanupFailures("real PDF upload", productError, cleanupErrors);
  }
});
