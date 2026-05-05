import { expect, test } from "@playwright/test";
import path from "node:path";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

test("@real-media owner can see delete action and legacy retrieval filters stay rejected", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const query = seed.fixtures.web.query;
  const disposablePdfPath = path.join(
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

  const legacySearch = await page.request.get("/api/search", {
    params: { q: query, types: "fragment,transcript_chunk" },
  });
  expect(legacySearch.status()).toBe(400);
  expect((await legacySearch.json()).error.code).toBe("E_INVALID_REQUEST");

  await page.goto(`/media/${mediaId}`);
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await page.getByRole("button", { name: "Actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /Delete document/ }),
  ).toBeVisible();

  await page.goto("/libraries");
  await page.getByRole("button", { name: "Add content" }).click();
  const addContentDialog = page.getByRole("dialog", { name: "Add content" });
  await expect(addContentDialog).toBeVisible();
  await addContentDialog.getByLabel("Upload file").setInputFiles(disposablePdfPath);
  await expect(page).toHaveURL(/\/media\/[0-9a-f-]+/i, { timeout: 30_000 });
  const match = page.url().match(/\/media\/([0-9a-f-]{36})/i);
  expect(match, `Expected media id in ${page.url()}`).toBeTruthy();
  const deletedMediaId = match![1];

  await page.getByRole("button", { name: "Actions" }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Delete");
    await dialog.accept();
  });
  await page.getByRole("menuitem", { name: /Delete document/ }).click();
  await expect(page).toHaveURL(/\/libraries/, { timeout: 15_000 });
  const deletedMedia = await page.request.get(`/api/media/${deletedMediaId}`);
  expect(deletedMedia.status()).toBe(404);
  const deletedSearch = await page.request.get("/api/search", {
    params: {
      q: "support vector",
      scope: `media:${deletedMediaId}`,
      types: "content_chunk",
      limit: "5",
    },
  });
  expect(deletedSearch.ok()).toBeTruthy();
  expect((await deletedSearch.json()).results).toEqual([]);

  writeRealMediaTrace(testInfo, "real-media-delete-permissions-trace.json", {
    shared_media_id: mediaId,
    rejected_legacy_filters: legacySearch.status(),
    deleted_media_id: deletedMediaId,
    deleted_fixture_id: "pdf-svms",
    deleted_media_status: deletedMedia.status(),
    browser_url: page.url(),
  });
});
