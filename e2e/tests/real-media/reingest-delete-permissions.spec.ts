import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  readRealMediaSeed,
  searchRealMediaEvidenceThroughUi,
  writeRealMediaTrace,
} from "./real-media-seed";

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");

function runWebArticleRefresh(mediaId: string, userId: string) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to drain the web article refresh worker.");
  }

  const raw = execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-c",
      `
import json
import os
from uuid import UUID

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from nexus.tasks.ingest_web_article import run_ingest_sync

engine = create_engine(os.environ["DATABASE_URL"])
Session = sessionmaker(bind=engine)
with Session() as session:
    result = run_ingest_sync(
        session,
        UUID(os.environ["NEXUS_E2E_REFRESH_MEDIA_ID"]),
        UUID(os.environ["NEXUS_E2E_USER_ID"]),
        "real-media-e2e-visible-refresh",
    )
    session.commit()
print(json.dumps(result, sort_keys=True))
`,
    ],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        NEXUS_ENV: "local",
        REAL_MEDIA_PROVIDER_FIXTURES: "1",
        REAL_MEDIA_FIXTURE_DIR: path.join(ROOT_DIR, "python/tests/fixtures/real_media"),
        NEXUS_E2E_REFRESH_MEDIA_ID: mediaId,
        NEXUS_E2E_USER_ID: userId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .toString()
    .trim();

  const lines = raw.split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? "{}") as {
    status?: string;
    reason?: string;
  };
}

test("@real-media owner can see delete action and legacy retrieval filters stay rejected", async ({
  page,
}, testInfo) => {
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

  const legacySearch = await page.request.get("/api/search", {
    params: { q: query, types: "fragment,transcript_chunk" },
  });
  expect(legacySearch.status()).toBe(400);
  expect((await legacySearch.json()).error.code).toBe("E_INVALID_REQUEST");

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
  await page.getByRole("button", { name: "Actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: /Delete document/ }),
  ).toBeVisible();

  await page.goto(`/media/${refreshMediaId}`);
  await expect(page.locator("body")).not.toContainText(
    /not found|failed to load/i,
  );
  await page.getByRole("button", { name: "Actions" }).click();
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

  const meResponse = await page.request.get("/api/me");
  expect(meResponse.ok()).toBeTruthy();
  const me = await meResponse.json();
  const workerResult = runWebArticleRefresh(refreshMediaId, me.data.user_id);
  expect(workerResult.status).toBe("success");
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/media/${refreshMediaId}`);
      if (!response.ok()) {
        return "missing";
      }
      return (await response.json()).data.retrieval_status;
    }, { timeout: 20_000 })
    .toBe("ready");

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
  expect(modelsResponse.ok()).toBeTruthy();
  const models = await modelsResponse.json();
  expect(models.data.length, "real-media seed should expose at least one chat model").toBeGreaterThan(0);
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
  const deletedSearch = await searchRealMediaEvidenceThroughUi(
    page,
    "support vector",
    "pdf",
  );
  expect(deletedSearch.results).toEqual([]);
  await expect(page.getByText("No results found.")).toBeVisible();
  await expect(
    page.locator(`a[href*="/media/${deletedMediaId}?"]`),
  ).toHaveCount(0);

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
    rejected_legacy_filters: legacySearch.status(),
    deleted_media_id: deletedMediaId,
    deleted_fixture_id: "pdf-svms",
    deleted_media_status: deletedMedia.status(),
    deleted_search_api_url: deletedSearch.api_url,
    deleted_search_result_count: deletedSearch.results.length,
    browser_url: page.url(),
  });
});
