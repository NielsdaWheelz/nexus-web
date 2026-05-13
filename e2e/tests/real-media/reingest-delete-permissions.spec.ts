import { expect, test } from "@playwright/test";
import path from "node:path";
import { deleteE2eResource, throwE2eCleanupFailures } from "../cleanup";
import {
  drainRealMediaWorkerForMediaReady,
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

test("@real-media owner can refresh and delete real-media documents", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;
  const refreshMediaId = seed.fixtures.web_url.media_id;
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

  const initialRefreshSearch = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "web_article",
  );
  const initialRefreshResult = initialRefreshSearch.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === refreshMediaId,
  );
  expect(initialRefreshResult, "refresh fixture should have initial evidence").toBeTruthy();
  if (!initialRefreshResult) {
    throw new Error(`refresh fixture search did not return ${refreshMediaId}`);
  }

  await page.goto(`/media/${mediaId}`);
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await page.getByRole("button", { name: "Options" }).last().click();
  await expect(
    page.getByRole("menuitem", { name: /Delete document/ }),
  ).toBeVisible();

  await page.goto(`/media/${refreshMediaId}`);
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await page.getByRole("button", { name: "Options" }).last().click();
  const refreshResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/media/${refreshMediaId}/refresh`),
  );
  await page.getByRole("menuitem", { name: "Refresh source" }).click();
  const refreshResponse = await refreshResponsePromise;
  expect(refreshResponse.status()).toBe(202);
  await expect(page.getByText("Source refresh started.")).toBeVisible({
    timeout: 10_000,
  });
  const refreshedMedia = await page.request.get(`/api/media/${refreshMediaId}`);
  expect(refreshedMedia.ok()).toBeTruthy();
  expect((await refreshedMedia.json()).data.processing_status).toBe("extracting");

  const workerResult = await drainRealMediaWorkerForMediaReady(page, refreshMediaId);
  expect(workerResult.status).toBe("success");

  const postRefreshSearch = await searchRealMediaEvidenceThroughUi(
    page,
    query,
    "web_article",
  );
  const postRefreshResult = postRefreshSearch.results.find(
    (item: { type: string; source: { media_id: string } }) =>
      item.type === "content_chunk" && item.source.media_id === refreshMediaId,
  );
  expect(postRefreshResult, "refresh should return replacement evidence").toBeTruthy();
  if (!postRefreshResult) {
    throw new Error(`refreshed search did not return ${refreshMediaId}`);
  }
  expect(postRefreshResult.context_ref.id).not.toBe(initialRefreshResult.context_ref.id);

  const modelsResponse = await page.request.get("/api/models");
  expect(modelsResponse.ok(), await modelsResponse.text()).toBeTruthy();
  const models = await modelsResponse.json();
  expect(
    models.data.length,
    "real-media seed should expose at least one chat model",
  ).toBeGreaterThan(0);
  const staleContextResponse = await page.request.post("/api/chat-runs", {
    headers: { "Idempotency-Key": `real-media-e2e-stale-${refreshMediaId}` },
    data: {
      content: "Use this stale evidence.",
      model_id: models.data[0].id,
      reasoning: "none",
      key_mode: "platform_only",
      conversation_scope: { type: "media", media_id: refreshMediaId },
      contexts: [
        {
          kind: "object_ref",
          type: "content_chunk",
          id: initialRefreshResult.context_ref.id,
          evidence_span_ids: initialRefreshResult.context_ref.evidence_span_ids,
        },
      ],
      web_search: { mode: "off" },
    },
  });
  expect(staleContextResponse.status()).toBe(400);
  expect((await staleContextResponse.json()).error.code).toBe("E_INVALID_REQUEST");

  let deletedMediaId: string | null = null;
  let deletedMediaStatus: number | null = null;
  let deletedSearchApiUrl: string | null = null;
  let deletedSearchResultCount: number | null = null;
  let productError: unknown = null;
  try {
    await page.goto("/libraries");
    await page.getByRole("button", { name: "Add content" }).click();
    const addContentDialog = page.getByRole("dialog", { name: "Add content" });
    await expect(addContentDialog).toBeVisible();
    await addContentDialog.getByLabel("Upload file").setInputFiles(disposablePdfPath);
    await expect(page).toHaveURL(/\/media\/[0-9a-f-]+/i, { timeout: 30_000 });
    const match = page.url().match(/\/media\/([0-9a-f-]{36})/i);
    expect(match, `Expected media id in ${page.url()}`).toBeTruthy();
    deletedMediaId = match![1];

    await page.getByRole("button", { name: "Options" }).last().click();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Delete");
      await dialog.accept();
    });
    await page.getByRole("menuitem", { name: /Delete document/ }).click();
    await expect(page).toHaveURL(/\/libraries/, { timeout: 15_000 });
    const deletedMedia = await page.request.get(`/api/media/${deletedMediaId}`);
    deletedMediaStatus = deletedMedia.status();
    expect(deletedMediaStatus).toBe(404);
    const deletedSearch = await searchRealMediaEvidenceThroughUi(
      page,
      "support vector",
      "pdf",
    );
    deletedSearchApiUrl = deletedSearch.api_url;
    deletedSearchResultCount = deletedSearch.results.length;
    expect(
      deletedSearch.results.some(
        (item: { source?: { media_id?: string } }) =>
          item.source?.media_id === deletedMediaId,
      ),
      "deleted media evidence must not remain searchable",
    ).toBe(false);
    await expect(
      page.locator(`a[href*="/media/${deletedMediaId}?"]`),
    ).toHaveCount(0);
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (deletedMediaId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/media/${deletedMediaId}`,
          `Disposable media ${deletedMediaId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwE2eCleanupFailures("Real-media disposable delete flow", productError, cleanupErrors);
  }

  writeRealMediaTrace(testInfo, "real-media-delete-permissions-trace.json", {
    shared_media_id: mediaId,
    refreshed_media_id: refreshMediaId,
    refresh_status: refreshResponse.status(),
    initial_refresh_search_api_url: initialRefreshSearch.api_url,
    initial_refresh_context_ref: initialRefreshResult.context_ref,
    refresh_worker_result: workerResult,
    post_refresh_search_api_url: postRefreshSearch.api_url,
    post_refresh_context_ref: postRefreshResult.context_ref,
    stale_context_status: staleContextResponse.status(),
    deleted_media_id: deletedMediaId,
    deleted_fixture_id: "pdf-svms",
    deleted_media_status: deletedMediaStatus,
    deleted_search_api_url: deletedSearchApiUrl,
    deleted_search_result_count: deletedSearchResultCount,
    browser_url: page.url(),
  });
});
