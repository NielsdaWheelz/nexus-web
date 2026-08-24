import type { APIResponse, Page } from "playwright/test";
import { uniqueCanonicalReaderEpub } from "../corpus";
import { uploadDocument } from "../documentUploadFixture";
import {
  expect,
  gotoWithStrictCsp,
  minioOrigin,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import {
  matchesResponse,
  pageRequest,
  type ExactOriginRequest,
} from "../request";

test.use({ journeyId: "durable-consumption-activity" });

interface ConsumptionStatsPayload {
  data: {
    activity: {
      totals: {
        activeMs: number;
        recordedActiveMs: number;
        excludedActiveMs: number;
      };
      media: {
        rows: Array<{
          mediaRef: string;
          title: string;
          activeMs: number;
        }>;
      };
      activeExclusions: Array<{ exclusionHandle: string }>;
    };
  };
}

interface EpubSection {
  section_id: string;
  label: string;
  href_path: string | null;
  start_offset: number;
}

async function readJson<T>(response: APIResponse, label: string): Promise<T> {
  const text = await response.text();
  expect(
    response.ok(),
    `${label} failed: ${response.status()} ${text.slice(0, 500)}`,
  ).toBeTruthy();
  return JSON.parse(text) as T;
}

async function uploadReadableEpub(page: Page, userId: string): Promise<string> {
  const api = pageRequest(page, webOrigin);
  const objects = pageRequest(page, minioOrigin);
  const epub = uniqueCanonicalReaderEpub(userId);
  const published = await uploadDocument({
    api,
    objects,
    payload: epub,
    kind: "Epub",
    filename: "canonical-durable-consumption-activity.epub",
    idempotencyKey: `durable-consumption-activity-${userId}`,
  });
  const mediaId = published.mediaId;
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        return ((await response.json()) as {
          data: { processing_status: string };
        }).data.processing_status;
      },
      {
        message: `Expected Consumption journey EPUB ${mediaId} to become readable.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");
  return mediaId;
}

function allTimeStatsPath(): `/api/${string}` {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const query = new URLSearchParams({
    timeZone: "UTC",
    bucket: "Year",
    end: tomorrow.toISOString(),
  });
  return `/api/consumption/stats?${query}`;
}

async function consumptionStats(
  api: ExactOriginRequest,
  path: `/api/${string}`,
): Promise<ConsumptionStatsPayload["data"]> {
  return (await readJson<ConsumptionStatsPayload>(
    await api.get(path),
    "Consumption stats projection",
  )).data;
}

test("restored reader input is durably projected as observed time in mounted Stats", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const mediaId = await uploadReadableEpub(page, journeyUser.id);
  const navigation = await readJson<{
    data: { sections: EpubSection[] };
  }>(
    await api.get(`/api/media/${mediaId}/navigation`),
    `EPUB navigation for ${mediaId}`,
  );
  const target = navigation.data.sections.find(
    (section) => section.label === "Second" && section.href_path !== null,
  );
  expect(
    target,
    `EPUB ${mediaId} did not expose the fixture-owned Second section.`,
  ).toBeDefined();

  await readJson(
    await api.put(`/api/media/${mediaId}/reader-state`, {
      headers: { origin: webOrigin },
      data: {
        locator: {
          kind: "epub",
          target: {
            section_id: target!.section_id,
            href_path: target!.href_path,
            anchor_id: null,
          },
          locations: {
            text_offset: target!.start_offset,
            progression: null,
            total_progression: null,
            position: null,
          },
          text: {
            quote: null,
            quote_prefix: null,
            quote_suffix: null,
          },
        },
        base_revision: 0,
      },
    }),
    `Persisted reader restore for ${mediaId}`,
  );

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page.getByRole("heading", { name: target!.label, exact: true }),
    `Reader did not restore section ${target!.section_id} (${target!.label}).`,
  ).toBeVisible();
  const restoredPassage = page
    .getByText(/Omega proves the selected section/)
    .first();
  await expect(
    restoredPassage,
    `Reader restored ${target!.label} without its fixture-owned passage.`,
  ).toBeVisible();

  const statsPath = allTimeStatsPath();
  const beforeInput = await consumptionStats(api, statsPath);
  expect(
    beforeInput.activity.totals.recordedActiveMs,
    "A programmatic reader restore must not create Consumption activity.",
  ).toBe(0);

  await restoredPassage.hover();
  await page.mouse.wheel(0, 480);
  const readerMore = page.getByRole("button", { name: "More", exact: true });
  await expect(
    readerMore,
    "The reader never exposed its contextual More control after trusted capture began.",
  ).toBeVisible();
  await readerMore.click();
  const recordingAction = page.getByRole("menuitem", {
    name: "Activity: Recording",
    exact: true,
  });
  await expect(
    recordingAction,
    "A trusted Chromium wheel inside the restored reader did not publish Activity: Recording inside More.",
  ).toBeVisible();
  const readerDocumentTimeOrigin = await page.evaluate(
    () => performance.timeOrigin,
  );
  const acceptedCapture = page.waitForResponse(
    (response) =>
      matchesResponse(
        response,
        webOrigin,
        "POST",
        "/api/consumption/activity",
    ) && response.status() === 204,
    { timeout: 15_000 },
  );
  await recordingAction.click();
  const captureResponse = await acceptedCapture;
  expect(
    captureResponse.status(),
    "Reader capture was not accepted by the public Consumption endpoint.",
  ).toBe(204);

  await expect(page).toHaveURL(/\/stats(?:[?#]|$)/);
  expect(
    await page.evaluate(() => performance.timeOrigin),
    "Opening Stats replaced the browser document instead of projecting the accepted capture in-process.",
  ).toBe(readerDocumentTimeOrigin);
  const summary = page.getByRole("region", { name: "Activity summary" });
  await expect(
    summary,
    "Mounted Stats did not refresh to the just-accepted reader activity.",
  ).toBeVisible({ timeout: 15_000 });
  await expect(summary).toContainText("Observed time");
  await expect(
    page
      .getByRole("button", {
        name: "Canonical Reader Positions",
        exact: true,
      })
      .first(),
    `Mounted Stats omitted the recorded work ${mediaId}.`,
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        const projected = await consumptionStats(api, statsPath);
        const totals = projected.activity.totals;
        const work = projected.activity.media.rows.find(
          (row) => row.mediaRef === `media:${mediaId}`,
        );
        return (
          totals.recordedActiveMs > 0 &&
          totals.excludedActiveMs === 0 &&
          totals.activeMs === totals.recordedActiveMs &&
          (work?.activeMs ?? 0) > 0
        );
      },
      {
        message: `Expected accepted reader capture for ${mediaId} in the public Stats projection.`,
        timeout: 15_000,
      },
    )
    .toBe(true);

  const projected = await consumptionStats(api, statsPath);
  expect(projected.activity.totals.recordedActiveMs).toBeGreaterThan(0);
  expect(projected.activity.totals.activeMs).toBe(
    projected.activity.totals.recordedActiveMs,
  );
  expect(
    projected.activity.media.rows.find(
      (row) => row.mediaRef === `media:${mediaId}`,
    )?.activeMs ?? 0,
  ).toBeGreaterThan(0);

  const sessionActions = page
    .getByRole("button", {
      name: /^Actions for Canonical Reader Positions, Reading,/,
    })
    .first();
  await expect(
    sessionActions,
    "The exact observed session did not expose its quiet correction action.",
  ).toBeVisible();
  await sessionActions.click();
  const excluded = page.waitForResponse(
    (response) =>
      matchesResponse(
        response,
        webOrigin,
        "POST",
        "/api/consumption/activity-exclusions",
      ) && response.status() === 200,
    { timeout: 15_000 },
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("menuitem", { name: "Don’t count this session", exact: true })
    .click();
  await excluded;
  await expect(
    page.getByRole("heading", { name: "Excluded activity", exact: true }),
    "The mounted Stats view did not project the accepted exclusion.",
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const afterExclusion = await consumptionStats(api, statsPath);
        return (
          afterExclusion.activity.totals.recordedActiveMs > 0 &&
          afterExclusion.activity.totals.excludedActiveMs ===
            afterExclusion.activity.totals.recordedActiveMs &&
          afterExclusion.activity.totals.activeMs === 0 &&
          afterExclusion.activity.activeExclusions.length === 1
        );
      },
      {
        message: `Expected exact exclusion for ${mediaId} in the public Stats projection.`,
        timeout: 15_000,
      },
    )
    .toBe(true);

  const restored = page.waitForResponse(
    (response) =>
      matchesResponse(
        response,
        webOrigin,
        "POST",
        "/api/consumption/activity-exclusions",
      ) && response.status() === 200,
    { timeout: 15_000 },
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", {
      name: /^Restore Canonical Reader Positions session from/,
    })
    .click();
  await restored;
  await expect(sessionActions).toBeVisible();
  await expect
    .poll(
      async () => {
        const afterRestore = await consumptionStats(api, statsPath);
        return (
          afterRestore.activity.totals.recordedActiveMs > 0 &&
          afterRestore.activity.totals.excludedActiveMs === 0 &&
          afterRestore.activity.totals.activeMs ===
            afterRestore.activity.totals.recordedActiveMs &&
          afterRestore.activity.activeExclusions.length === 0
        );
      },
      {
        message: `Expected exact restore for ${mediaId} in the public Stats projection.`,
        timeout: 15_000,
      },
    )
    .toBe(true);
});
