import {
  expect,
  test,
  type APIResponse,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import {
  activeWorkspacePane,
  expectNoDocumentHorizontalOverflow,
  gotoSinglePaneWorkspace,
  waitForWorkspaceHydration,
} from "./workspace";

interface SeededMedia {
  media_id: string;
}

interface SeededAudio extends SeededMedia {
  podcast_id: string;
  title: string;
  stream_path: string;
  successor_media_id: string;
  successor_title: string;
  successor_stream_path: string;
  duration_seconds: number;
}

interface LecternItem {
  itemId: string;
  mediaId: string;
}

interface ListeningState {
  positionMs: number;
  durationMs: { kind: "Absent" } | { kind: "Present"; value: number };
  episodePlaybackRate:
    | { kind: "Absent" }
    | { kind: "Present"; value: number };
  writeRevision: number;
  resetEpoch: number;
}

interface ResetProgressState {
  mediaId: string;
  readerCursor: { state: string; revision: number };
  listeningState:
    { kind: "Absent" } | { kind: "Present"; value: ListeningState };
}

interface StatsEnvelope {
  data: {
    activity: {
      totals: {
        activeMs: number;
        forwardWordPosition: number;
        forwardMediaPositionMs: number;
        sessionCount: number;
      };
      timeline: Array<{
        readingActiveMs: number;
        listeningActiveMs: number;
        viewingActiveMs: number;
      }>;
      devices: Array<{
        deviceHandle: string;
        label: string;
        isCurrent: boolean;
      }>;
    };
  };
}

function seededArticle(): SeededMedia {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", ".seed", "non-pdf-media.json"),
      "utf-8",
    ),
  ) as SeededMedia;
}

function seededVideo(): SeededMedia {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", ".seed", "youtube-media.json"),
      "utf-8",
    ),
  ) as SeededMedia;
}

function seededAudio(): SeededAudio {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", ".seed", "activity-audio-media.json"),
      "utf-8",
    ),
  ) as SeededAudio;
}

function toneWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * durationSeconds;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < dataSize; sample += 1) {
    bytes[44 + sample] =
      128 +
      Math.round(Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 48);
  }
  return bytes;
}

async function resetAudioProgress(
  page: Parameters<typeof gotoSinglePaneWorkspace>[0],
  mediaId: string,
): Promise<ResetProgressState> {
  const reset = await page.request.post("/api/consumption/commands", {
    headers: stateChangingApiHeaders(),
    data: { kind: "ResetProgress", clientMutationId: randomUUID(), mediaId },
  });
  expect(reset.ok()).toBe(true);
  const resetBody = (await reset.json()) as {
    data: {
      progressState: {
        kind: string;
        value?: ResetProgressState;
      };
    };
  };
  expect(resetBody.data.progressState).toMatchObject({
    kind: "Present",
    value: {
      mediaId,
      readerCursor: { state: "Empty" },
      listeningState: {
        kind: "Present",
        value: { positionMs: 0 },
      },
    },
  });
  if (
    resetBody.data.progressState.kind !== "Present" ||
    resetBody.data.progressState.value === undefined
  ) {
    throw new Error("ResetProgress omitted its canonical progress state");
  }
  return resetBody.data.progressState.value;
}

async function resetAndPlaceAudio(
  page: Parameters<typeof gotoSinglePaneWorkspace>[0],
  mediaId: string,
): Promise<void> {
  await removeAudioFromLectern(page, [mediaId]);
  await resetAudioProgress(page, mediaId);
  const placed = await page.request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: {
      kind: "PlaceItems",
      clientMutationId: randomUUID(),
      mediaIds: [mediaId],
      placement: { kind: "Last" },
    },
  });
  expect(placed.ok()).toBe(true);
}

async function removeAudioFromLectern(
  page: Parameters<typeof gotoSinglePaneWorkspace>[0],
  mediaIds: string[],
): Promise<void> {
  const lecternResponse = await page.request.get("/api/lectern");
  expect(lecternResponse.ok()).toBe(true);
  const current = (await lecternResponse.json()) as {
    data: { items: LecternItem[] };
  };
  for (const item of current.data.items.filter(
    (candidate) => mediaIds.includes(candidate.mediaId),
  )) {
    const removed = await page.request.post("/api/lectern/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "RemoveItem",
        clientMutationId: randomUUID(),
        itemId: item.itemId,
      },
    });
    expect(removed.ok()).toBe(true);
  }
}

async function postActivity(
  response: Promise<APIResponse | PlaywrightResponse>,
): Promise<void> {
  const value = await response;
  if (value.status() !== 204) {
    const requestBody =
      "request" in value ? value.request().postData() : "<API request>";
    throw new Error(
      `Activity capture failed (${value.status()}): ${await value.text()}; request=${requestBody}`,
    );
  }
  expect(value.headers()["cache-control"]).toBe("private, no-store");
}

test("resets podcast progress through the BFF to a canonical install snapshot", async ({
  page,
}) => {
  const audio = seededAudio();
  const rawDeviceId = `e2e-consumption-reset-${randomUUID()}`;
  await gotoSinglePaneWorkspace(page, rawDeviceId, "/lectern");

  const beforeResponse = await page.request.get(
    `/api/media/${audio.media_id}/listening-state`,
  );
  expect(beforeResponse.ok()).toBe(true);
  const before = (await beforeResponse.json()) as { data: ListeningState };
  const heartbeatGeneration = randomUUID();
  const heartbeat = await page.request.put(
    `/api/media/${audio.media_id}/listening-state`,
    {
      headers: stateChangingApiHeaders(),
      data: {
        positionMs: 12_000,
        durationMs: {
          kind: "Present",
          value: audio.duration_seconds * 1_000,
        },
        episodePlaybackRate: { kind: "Present", value: 1.25 },
        expectedWriteRevision: before.data.writeRevision,
        expectedResetEpoch: before.data.resetEpoch,
        heartbeatGeneration,
        heartbeatSequence: 1,
      },
    },
  );
  expect(heartbeat.ok()).toBe(true);

  const reset = await resetAudioProgress(page, audio.media_id);
  expect(reset.readerCursor.revision).toBeGreaterThanOrEqual(1);
  if (reset.listeningState.kind !== "Present") {
    throw new Error("Podcast ResetProgress omitted its listening state");
  }
  expect(reset.listeningState).toMatchObject({
    kind: "Present",
    value: {
      positionMs: 0,
      durationMs: {
        kind: "Present",
        value: audio.duration_seconds * 1_000,
      },
      episodePlaybackRate: { kind: "Present", value: 1.25 },
      writeRevision: before.data.writeRevision + 2,
      resetEpoch: before.data.resetEpoch + 1,
    },
  });

  const afterResponse = await page.request.get(
    `/api/media/${audio.media_id}/listening-state`,
  );
  expect(afterResponse.ok()).toBe(true);
  const after = (await afterResponse.json()) as { data: ListeningState };
  expect(after.data).toEqual(reset.listeningState.value);
});

test("inherits podcast playback speed and resumes an episode override", async ({
  page,
}) => {
  test.slow();
  const audio = seededAudio();
  const rawDeviceId = `e2e-playback-rate-${randomUUID()}`;
  const subscriptionHeaders = {
    ...stateChangingApiHeaders(),
    "Idempotency-Key": randomUUID(),
  };
  await page.route(
    new RegExp(
      `(?:${audio.stream_path}|${audio.successor_stream_path})$`,
    ),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: toneWav(audio.duration_seconds),
      }),
  );
  await gotoSinglePaneWorkspace(page, rawDeviceId, "/lectern");

  const priorSubscription = await page.request.delete(
    `/api/podcasts/subscriptions/${audio.podcast_id}`,
    { headers: subscriptionHeaders },
  );
  expect(
    priorSubscription.ok(),
    await priorSubscription.text(),
  ).toBeTruthy();
  const subscribed = await page.request.post("/api/podcasts/subscriptions", {
    headers: {
      ...stateChangingApiHeaders(),
      "Idempotency-Key": randomUUID(),
    },
    data: {
      target: { kind: "Canonical", podcastId: audio.podcast_id },
      namedLibraryIds: [],
      replacementConfirmation: { kind: "Absent" },
    },
  });
  expect(subscribed.ok(), await subscribed.text()).toBeTruthy();

  try {
    const preference = await page.request.patch(
      `/api/podcasts/subscriptions/${audio.podcast_id}/settings`,
      {
        headers: stateChangingApiHeaders(),
        data: {
          default_playback_speed: { kind: "Present", value: 1.5 },
        },
      },
    );
    expect(preference.ok(), await preference.text()).toBeTruthy();

    await resetAndPlaceAudio(page, audio.media_id);
    await resetAudioProgress(page, audio.successor_media_id);
    await gotoSinglePaneWorkspace(page, rawDeviceId, "/lectern");
    await activeWorkspacePane(page)
      .getByRole("button", { name: `Play ${audio.title}` })
      .click();

    const audioElement = page.locator(
      'audio[aria-label="Media player audio"]',
    );
    await expect(audioElement).toHaveJSProperty("paused", false);
    await expect
      .poll(() =>
        audioElement.evaluate(
          (element) => (element as HTMLAudioElement).playbackRate,
        ),
      )
      .toBe(1.5);
    await expect(
      page.getByRole("button", {
        name: "Playback speed, 1.5 times",
      }),
    ).toBeVisible();

    const persistedRate = page.waitForResponse((response) => {
      if (
        response.request().method() !== "PUT" ||
        new URL(response.url()).pathname !==
          `/api/media/${audio.media_id}/listening-state`
      ) {
        return false;
      }
      const rate = (
        response.request().postDataJSON() as {
          episodePlaybackRate?: { kind?: string; value?: number };
        }
      ).episodePlaybackRate;
      return rate?.kind === "Present" && rate.value === 1.75;
    });
    await page
      .getByRole("button", { name: "Playback speed, 1.5 times" })
      .click();
    const playbackDialog = page.getByRole("dialog", { name: "Playback" });
    await playbackDialog
      .getByRole("slider", { name: "Playback speed" })
      .fill("1.75");
    expect((await persistedRate).ok()).toBeTruthy();
    await expect(audioElement).toHaveJSProperty("playbackRate", 1.75);
    await page.keyboard.press("Escape");

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkspaceHydration(page);
    await activeWorkspacePane(page)
      .getByRole("button", { name: `Play ${audio.title}` })
      .click();
    await expect(audioElement).toHaveJSProperty("playbackRate", 1.75);

    await page
      .getByRole("region", { name: "Media player" })
      .getByRole("button", { name: "Close player" })
      .click();
    await resetAndPlaceAudio(page, audio.successor_media_id);
    await gotoSinglePaneWorkspace(page, rawDeviceId, "/lectern");
    await activeWorkspacePane(page)
      .getByRole("button", { name: `Play ${audio.successor_title}` })
      .click();
    await expect(audioElement).toHaveJSProperty("playbackRate", 1.5);
  } finally {
    await removeAudioFromLectern(page, [
      audio.media_id,
      audio.successor_media_id,
    ]);
    const unsubscribed = await page.request.delete(
      `/api/podcasts/subscriptions/${audio.podcast_id}`,
      {
        headers: {
          ...stateChangingApiHeaders(),
          "Idempotency-Key": randomUUID(),
        },
      },
    );
    expect(unsubscribed.ok(), await unsubscribed.text()).toBeTruthy();
  }
});

test("records private activity through the BFF and renders filtered Stats", async ({
  page,
}) => {
  test.slow();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const mediaId = seededArticle().media_id;
  const videoMediaId = seededVideo().media_id;
  const audio = seededAudio();
  const rawDeviceId = `e2e-consumption-stats-${randomUUID()}`;
  await page.route(`**${audio.stream_path}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: toneWav(audio.duration_seconds),
    }),
  );
  await gotoSinglePaneWorkspace(page, rawDeviceId, `/media/${mediaId}`);

  const readingCapture = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/consumption/activity"
    ) {
      return false;
    }
    const batch = (
      response.request().postDataJSON() as {
        batch?: {
          modality?: string;
          spans?: Array<{ durationMs?: number }>;
        };
      }
    ).batch;
    return (
      batch?.modality === "Reading" &&
      batch.spans?.some((span) => (span.durationMs ?? 0) > 5_000) === true
    );
  });
  const readerViewport =
    activeWorkspacePane(page).getByTestId("document-viewport");
  const readerSurface = readerViewport.locator("[data-focus-mode]");
  await expect(readerSurface).toBeVisible();
  await page.bringToFront();
  await readerSurface.click({ position: { x: 20, y: 20 } });
  await readerSurface.hover();
  const initialScrollTop = await readerViewport.evaluate(
    (element) => element.scrollTop,
  );
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() => readerViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(initialScrollTop + 100);
  const forwardScrollTop = await readerViewport.evaluate(
    (element) => element.scrollTop,
  );
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.waitForTimeout(10_500);
  expect(
    await readerViewport.evaluate((element) => element.scrollTop),
    "A deferred canonical restore overrode genuine forward reading input.",
  ).toBeGreaterThanOrEqual(forwardScrollTop);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Libraries" })
    .click();
  const readingResponse = await readingCapture;
  await postActivity(Promise.resolve(readingResponse));
  const readingBatch = (
    readingResponse.request().postDataJSON() as {
      batch: {
        spans: Array<{
          durationMs: number;
          wordStart: { kind: string; value?: number };
          wordEnd: { kind: string; value?: number };
        }>;
      };
    }
  ).batch;
  const organicReadingSpan = readingBatch.spans.find(
    (span) => span.durationMs > 5_000,
  );
  expect(
    organicReadingSpan,
    `No organic reading span exceeded five seconds: ${JSON.stringify(readingBatch.spans)}`,
  ).toBeDefined();
  expect(
    organicReadingSpan,
    `Organic reading omitted canonical word positions: ${JSON.stringify(organicReadingSpan)}`,
  ).toMatchObject({
    wordStart: { kind: "Present" },
    wordEnd: { kind: "Present" },
  });
  const forwardReadingSpan = readingBatch.spans.find(
    (span) =>
      span.wordStart.kind === "Present" &&
      span.wordEnd.kind === "Present" &&
      (span.wordEnd.value ?? 0) > (span.wordStart.value ?? Number.MAX_VALUE),
  );
  expect(
    forwardReadingSpan,
    `Organic reading never moved forward: ${JSON.stringify(readingBatch.spans)}`,
  ).toBeDefined();

  await gotoSinglePaneWorkspace(page, rawDeviceId, `/media/${videoMediaId}`);
  const viewingCapture = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/consumption/activity"
    ) {
      return false;
    }
    return (
      (
        response.request().postDataJSON() as {
          batch?: { modality?: string };
        }
      ).batch?.modality === "Viewing"
    );
  });
  await expect(
    activeWorkspacePane(page).locator('iframe[title="YouTube video player"]'),
  ).toBeVisible();
  await page.waitForTimeout(10_500);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Libraries" })
    .click();
  await postActivity(viewingCapture);

  await resetAndPlaceAudio(page, audio.media_id);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSinglePaneWorkspace(page, rawDeviceId, "/lectern");
  const listeningCapture = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      new URL(response.url()).pathname !== "/api/consumption/activity"
    ) {
      return false;
    }
    const batch = (
      response.request().postDataJSON() as {
        batch?: {
          modality?: string;
          spans?: Array<{
            mediaPositionEndMs?: { kind?: string; value?: number };
          }>;
        };
      }
    ).batch;
    return (
      batch?.modality === "Listening" &&
      batch.spans?.some(
        (span) =>
          span.mediaPositionEndMs?.kind === "Present" &&
          (span.mediaPositionEndMs.value ?? 0) > 5_000,
      ) === true
    );
  });
  await activeWorkspacePane(page)
    .getByRole("button", { name: `Play ${audio.title}` })
    .click();
  await expect(
    page.getByRole("region", { name: "Media player" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Media player" }),
  ).toHaveCount(1);
  await expectNoDocumentHorizontalOverflow(page);
  const audioElement = page.locator('audio[aria-label="Media player audio"]');
  await expect(audioElement).toHaveJSProperty("paused", false);
  await expect
    .poll(
      () =>
        audioElement.evaluate(
          (element) => (element as HTMLAudioElement).currentTime,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(1);

  await page
    .getByRole("button", { name: `Open Now Playing: ${audio.title}` })
    .click();
  const nowPlaying = page.getByRole("dialog", { name: "Now Playing" });
  await expect(nowPlaying).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Media player" }),
  ).toHaveCount(1);
  await nowPlaying
    .getByRole("button", { name: "Pause media player" })
    .click();
  await expect(audioElement).toHaveJSProperty("paused", true);

  const playerUrl = page.url();
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
  await expect(page).toHaveURL(playerUrl);
  const miniPlayer = page.getByRole("region", { name: "Media player" });
  await expect(miniPlayer).toBeVisible();
  await miniPlayer
    .getByRole("button", { name: "Play media player" })
    .click();
  await expect(audioElement).toHaveJSProperty("paused", false);

  await page.locator('button[aria-label^="Open Nexus,"]').click();
  const mobileNexus = page.getByRole("dialog", { name: "Nexus" });
  await mobileNexus
    .getByRole("region", { name: "Places" })
    .getByRole("button", { name: "Libraries" })
    .click();
  await expect(mobileNexus).toBeHidden();
  await page.waitForTimeout(10_500);
  await expect
    .poll(
      () =>
        audioElement.evaluate(
          (element) => (element as HTMLAudioElement).currentTime,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(10);
  await miniPlayer
    .getByRole("button", { name: "More player controls" })
    .click();
  await page.getByRole("menuitem", { name: "Close player" }).click();
  await expect(
    page.getByRole("region", { name: "Media player" }),
  ).toHaveCount(0);
  await expect(audioElement).toHaveJSProperty("paused", true);
  await expect(audioElement).not.toHaveAttribute("src");
  await postActivity(listeningCapture);

  await page.setViewportSize({ width: 1280, height: 720 });
  const occurredAt = new Date(Date.now() - 2_000).toISOString();
  const base = {
    mediaRef: `media:${mediaId}`,
    deviceClass: "Desktop",
  };
  await postActivity(
    page.request.post("/api/consumption/activity", {
      headers: stateChangingApiHeaders(),
      data: {
        ...base,
        clientMutationId: randomUUID(),
        batch: {
          modality: "Reading",
          spans: [
            {
              occurredAt,
              durationMs: 30_000,
              progressStart: { kind: "Present", value: 0.1 },
              progressEnd: { kind: "Present", value: 0.2 },
              wordStart: { kind: "Present", value: 10 },
              wordEnd: { kind: "Present", value: 40 },
            },
          ],
        },
      },
    }),
  );

  await page.getByRole("button", { name: "Search or ask anything" }).click();
  const initialStats = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/consumption/stats",
  );
  const nexus = page.getByRole("dialog", { name: "Nexus" });
  await nexus
    .getByRole("combobox", { name: "Find anything" })
    .fill("stats");
  await nexus.getByRole("option", { name: /^Stats\b/ }).click();

  const initialResponse = await Promise.race([
    initialStats,
    page
      .getByRole("region", { name: "Pane failed to render" })
      .waitFor({ state: "visible" })
      .then(() => {
        throw new Error(
          `Stats pane failed before its first read: ${
            [...pageErrors, ...consoleErrors].join(" | ") ||
            "no browser error event"
          }`,
        );
      }),
  ]);
  expect(initialResponse.ok()).toBe(true);
  expect(initialResponse.headers()["cache-control"]).toBe("private, no-store");
  const initialBody = (await initialResponse.json()) as StatsEnvelope;
  expect(JSON.stringify(initialBody)).not.toContain(rawDeviceId);
  const currentDevice = initialBody.data.activity.devices.find(
    (device) => device.isCurrent,
  );
  expect(currentDevice).toMatchObject({ label: "This device" });
  expect(currentDevice?.deviceHandle).toMatch(/^ncd1\.[A-Za-z0-9_-]{22}$/);

  const pane = activeWorkspacePane(page);
  await expect(
    pane.getByRole("heading", {
      name: "Reading, listening, and video-pane time",
    }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Stats" }),
  ).toHaveAttribute("aria-current", "page");

  const filteredStats = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/api/consumption/stats" &&
      url.searchParams.has("deviceHandle")
    );
  });
  await pane
    .getByRole("button", { name: "Filter device: This device" })
    .click();
  const filteredResponse = await filteredStats;
  expect(filteredResponse.ok()).toBe(true);
  expect(filteredResponse.headers()["cache-control"]).toBe("private, no-store");
  const filteredBody = (await filteredResponse.json()) as StatsEnvelope;
  expect(JSON.stringify(filteredBody)).not.toContain(rawDeviceId);
  expect(filteredBody.data.activity.totals.sessionCount).toBe(3);
  expect(filteredBody.data.activity.totals.forwardWordPosition).toBeGreaterThan(
    30,
  );
  expect(
    filteredBody.data.activity.totals.forwardWordPosition,
  ).toBeLessThanOrEqual(500);
  expect(
    filteredBody.data.activity.totals.forwardMediaPositionMs,
  ).toBeGreaterThan(5_000);
  expect(
    filteredBody.data.activity.totals.forwardMediaPositionMs,
  ).toBeLessThanOrEqual(30_000);
  expect(filteredBody.data.activity.totals.activeMs).toBeGreaterThan(50_000);
  expect(filteredBody.data.activity.totals.activeMs).toBeLessThanOrEqual(
    90_000,
  );
  const modalityTotals = filteredBody.data.activity.timeline.reduce(
    (totals, bucket) => ({
      reading: totals.reading + bucket.readingActiveMs,
      listening: totals.listening + bucket.listeningActiveMs,
      viewing: totals.viewing + bucket.viewingActiveMs,
    }),
    { reading: 0, listening: 0, viewing: 0 },
  );
  expect(modalityTotals.reading).toBeGreaterThan(40_000);
  expect(modalityTotals.reading).toBeLessThanOrEqual(60_000);
  expect(modalityTotals.listening).toBeGreaterThan(5_000);
  expect(modalityTotals.listening).toBeLessThanOrEqual(30_000);
  expect(modalityTotals.viewing).toBeGreaterThan(0);
  expect(modalityTotals.viewing).toBeLessThanOrEqual(30_000);

  await expect(page).toHaveURL(/device=ncd1\.[A-Za-z0-9_-]{22}/);
  await expect(page.locator("body")).not.toContainText(rawDeviceId);
  await expect(
    pane.getByRole("region", { name: "Activity summary" }),
  ).toContainText("Active time");
  await expect(
    pane.getByRole("heading", { name: "Activity over time" }),
  ).toBeVisible();
  await expect(
    pane.getByRole("heading", { name: "Created and kept" }),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const response = await page.request.get(
        "/api/me/nexus-history?query=stats",
      );
      if (!response.ok()) return false;
      const body = (await response.json()) as {
        data: { recent: Array<{ target_href: string }> };
      };
      return body.data.recent.some((row) => row.target_href === "/stats");
    })
    .toBe(true);

  const filteredUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForWorkspaceHydration(page);
  await expect(page).toHaveURL(filteredUrl);
  await expect(
    activeWorkspacePane(page).getByRole("button", {
      name: "Clear device filter",
    }),
  ).toBeVisible();

  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(() => ({
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    })),
  ).toEqual({ forcedColors: true, reducedMotion: true });
  await expect(
    activeWorkspacePane(page).getByRole("heading", {
      name: "Reading, listening, and video-pane time",
    }),
  ).toBeVisible();
  await expectNoDocumentHorizontalOverflow(page);
});
