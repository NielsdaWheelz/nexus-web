import { expect, test } from "@playwright/test";
import path from "node:path";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media real PDF opens from upload-backed media and projects evidence", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.pdf.media_id;
  const query = seed.fixtures.pdf.query;
  const artifactPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "python",
    "tests",
    "fixtures",
    "pdf",
    "attention.pdf",
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

  const searchResponse = await page.request.get("/api/search", {
    params: {
      q: query,
      scope: `media:${mediaId}`,
      types: "content_chunk",
    },
  });
  expect(searchResponse.ok()).toBeTruthy();
  const search = await searchResponse.json();
  const result = search.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === mediaId,
  );
  expect(result, "real PDF should return indexed evidence").toBeTruthy();
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

  writeRealMediaTrace(testInfo, "real-pdf-upload-trace.json", {
    fixture_id: "pdf-attention",
    artifact_sha256: seed.fixtures.pdf.artifact_sha256,
    artifact_bytes: seed.fixtures.pdf.artifact_bytes,
    media_id: mediaId,
    query,
    search_result: result,
    resolver: resolver.data,
    browser_url: page.url(),
  });
});
