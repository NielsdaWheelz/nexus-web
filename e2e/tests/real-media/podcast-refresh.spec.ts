import { copyFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Request } from "@playwright/test";
import { activeWorkspacePane } from "../workspace";
import { startE2eWorkerUntilPodcastRefreshTerminal } from "../worker";
import {
  gotoRealMediaSinglePane,
  openActivePaneOptions,
  readRealMediaSeed,
} from "./real-media-seed";

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const SOURCE_FIXTURE_DIR = path.join(
  ROOT_DIR,
  "python/tests/fixtures/real_media",
);
const RUNTIME_FIXTURE_DIR =
  process.env.REAL_MEDIA_FIXTURE_DIR ??
  path.join(ROOT_DIR, "e2e/.seed/real-media-runtime");
const ACTIVE_FEED = path.join(RUNTIME_FIXTURE_DIR, "nasa-hwhap-feed.xml");
const FEED_V1 = path.join(SOURCE_FIXTURE_DIR, "nasa-hwhap-feed-v1.xml");
const FEED_V2 = path.join(SOURCE_FIXTURE_DIR, "nasa-hwhap-feed-v2.xml");
const NEW_EPISODE_TITLE = "Artemis II: Ready to Fly";

test("@real-media Podcast refresh imports a newly published episode through the real worker and SSE path", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const seed = readRealMediaSeed();
  const podcastId = String(seed.fixtures.podcast.podcast_id);
  const observedRequests: Request[] = [];
  page.on("request", (request) => observedRequests.push(request));

  copyFileSync(FEED_V1, ACTIVE_FEED);
  try {
    await gotoRealMediaSinglePane(page, `/podcasts/${podcastId}`);
    const pane = activeWorkspacePane(page);
    await expect(
      pane.getByRole("link", { name: "The Crew-4 Astronauts", exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("link", { name: NEW_EPISODE_TITLE, exact: true }),
    ).toHaveCount(0);

    const viewerResponse = await page.request.get("/api/me");
    expect(viewerResponse.ok()).toBeTruthy();
    const viewer = (await viewerResponse.json()) as {
      data: { user_id: string };
    };

    copyFileSync(FEED_V2, ACTIVE_FEED);
    await openActivePaneOptions(page, "Refresh");
    const admissionPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/podcasts/refresh-runs",
    );
    const streamPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /^\/stream\/podcast-refresh-runs\/[^/]+\/events$/u.test(
          new URL(response.url()).pathname,
        ),
    );
    await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
    const admissionResponse = await admissionPromise;
    expect(admissionResponse.status()).toBe(202);
    const admission = (await admissionResponse.json()) as {
      data: {
        refreshRunHandle: string;
        status: string;
        requestedCount: number;
      };
    };
    expect(admission.data.status).toBe("Running");
    expect(admission.data.requestedCount).toBe(1);
    const idempotencyKey = admissionResponse.request().headers()[
      "idempotency-key"
    ];
    if (!idempotencyKey) {
      throw new Error("Podcast refresh admission omitted Idempotency-Key");
    }
    const streamResponse = await streamPromise;
    expect(streamResponse.status()).toBe(200);
    expect(new URL(streamResponse.url()).pathname).toBe(
      `/stream/podcast-refresh-runs/${admission.data.refreshRunHandle}/events`,
    );

    const worker = await startE2eWorkerUntilPodcastRefreshTerminal({
      userId: viewer.data.user_id,
      idempotencyKey,
      extraEnv: {
        REAL_MEDIA_PROVIDER_FIXTURES: "1",
        REAL_MEDIA_FIXTURE_DIR: RUNTIME_FIXTURE_DIR,
      },
    });
    expect(
      worker.status,
      `Podcast refresh worker did not complete:\n${worker.stderr}\n${worker.stdout}`,
    ).toBe("Complete");
    expect(worker.worker_iterations).toBeGreaterThan(0);
    expect(
      worker.notification_seen,
      `Podcast refresh worker did not observe the run's Postgres notification:\n${worker.stderr}\n${worker.stdout}`,
    ).toBe(true);

    await expect(
      pane.getByRole("link", { name: NEW_EPISODE_TITLE, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      pane.locator('[aria-live="polite"]').filter({ hasText: "1 new episode" }),
    ).toBeVisible();

    const refreshHandle = admission.data.refreshRunHandle;
    expect(
      observedRequests.some(
        (request) =>
          request.method() === "GET" &&
          new URL(request.url()).pathname ===
            `/stream/podcast-refresh-runs/${refreshHandle}/events`,
      ),
      "the browser should observe the terminal snapshot over the direct SSE stream",
    ).toBeTruthy();
    expect(
      observedRequests.some(
        (request) =>
          request.method() === "GET" &&
          new URL(request.url()).pathname ===
            `/api/podcasts/refresh-runs/${refreshHandle}`,
      ),
      "healthy SSE completion must not use the observation-loss reconciliation GET",
    ).toBeFalsy();
  } finally {
    copyFileSync(FEED_V1, ACTIVE_FEED);
  }
});
