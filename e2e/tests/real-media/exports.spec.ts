import { expect, test } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media vault export includes block-derived article source text", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const needle = seed.fixtures.web.needle;

  const response = await page.request.get("/api/vault");
  expect(response.ok(), "vault export should succeed").toBeTruthy();
  const body = await response.json();
  const canonicalFile = body.data.files.find(
    (file: { path: string; content: string }) =>
      file.path.startsWith("Sources/") &&
      file.path.endsWith("/canonical.txt") &&
      file.content.includes(needle),
  );

  expect(
    canonicalFile,
    "vault export should include the real captured article text",
  ).toBeTruthy();
  expect(canonicalFile.content).toContain(needle);
  expect(canonicalFile.content).not.toContain("lorem ipsum");

  const mediaResponse = await page.request.get(`/api/media/${mediaId}`);
  expect(
    mediaResponse.ok(),
    `web media ${mediaId} should still be readable`,
  ).toBeTruthy();

  writeRealMediaTrace(testInfo, "real-media-export-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    needle,
    exported_path: canonicalFile.path,
    exported_content_length: canonicalFile.content.length,
  });
});
