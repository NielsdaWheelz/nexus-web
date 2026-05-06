import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  createFragmentHighlightThroughVisibleSelection,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media real EPUB opens from upload-backed media and projects evidence", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.epub.media_id;
  const query = seed.fixtures.epub.query;
  const artifactPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "python",
    "tests",
    "fixtures",
    "epub",
    "moby-dick-epub3.epub",
  );

  await page.goto("/libraries");
  await page.getByRole("button", { name: "Add content" }).click();
  const addContentDialog = page.getByRole("dialog", { name: "Add content" });
  await expect(addContentDialog).toBeVisible();
  await addContentDialog.getByLabel("Upload file").setInputFiles(artifactPath);
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}(\\?|$)`), {
    timeout: 30_000,
  });

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
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(result, "real EPUB should return indexed evidence").toBeTruthy();
  if (!result) {
    throw new Error(`real EPUB visible search did not return ${mediaId}`);
  }
  const resolverResponse = await page.request.get(
    `/api/media/${mediaId}/evidence/${result.evidence_span_ids[0]}`,
  );
  expect(resolverResponse.ok()).toBeTruthy();
  const resolver = await resolverResponse.json();

  const resultLink = page.locator(`a[href*="/media/${mediaId}?"]`).first();
  await expect(resultLink, "real EPUB should render a visible search result").toBeVisible();
  const visibleHref = await resultLink.getAttribute("href");
  await resultLink.click();
  await expect(page).toHaveURL(new RegExp(`/media/${mediaId}\\?`));
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await expect(
    page.locator('[data-highlight-anchor^="evidence-"], .hl-evidence').first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  const savedHighlight = await createFragmentHighlightThroughVisibleSelection(
    page,
    mediaId,
    '[class*="fragments"]',
  );

  writeRealMediaTrace(testInfo, "real-epub-upload-trace.json", {
    fixture_id: "epub-moby-dick-epub3",
    artifact_sha256: seed.fixtures.epub.artifact_sha256,
    artifact_bytes: seed.fixtures.epub.artifact_bytes,
    media_id: mediaId,
    query,
    search_api_url: search.api_url,
    search_result: result,
    visible_result_href: visibleHref,
    resolver: resolver.data,
    saved_highlight: savedHighlight,
    browser_url: page.url(),
  });
});
