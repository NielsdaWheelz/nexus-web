import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";
import { stateChangingApiHeaders } from "./api";

/**
 * Lectern + Global Player lifecycle — the one real-stack mixed-media E2E path
 * (spec `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §2 In-scope,
 * §1 behavior table, §6, §8 items 1/2/8/10/14).
 *
 * This proves the headline user journey against the real backend consumption
 * owner, the shell-resident player session, and the one Lectern editor:
 *
 *   (a) adding a Readable article to the Lectern from a product surface
 *       (the media pane "Options" menu → "Add to Lectern");
 *   (b) the Lectern pane lists a mixed-media set (Readable web article + video
 *       OpenPane) with server-derived activation + consumption, and a Readable
 *       row exposes no footer "Play" action (activation derivation, §4/§8.14);
 *   (c) reorder + remove with provider-owned optimistic UI (§6/§8.8);
 *   (d) reader "Mark as finished" (`finishLecternItem`) removes the *exact* row,
 *       and the 10-second Undo restores it with a *new* itemId in the Unread
 *       state (§1 table, §6 Undo, §8.2/§8.12);
 *   (e) the shell shows no player dock without an audio session (§1, §6);
 *   (f) focus revalidation discovers a background addition once past the
 *       coalescing window, without racing a mutation install (§6/§8.10).
 *
 * Deliberately NOT covered here (covered by integration/unit/real-media suites,
 * per §2 "the E2E proves the headline journey, not every branch"):
 *   - Any FooterAudio playback: real podcast audio is unavailable in the plain
 *     e2e project (E2E_REAL_MEDIA=0 seeds only Readable + video/OpenPane kinds),
 *     so play-from-Lectern → dock-appears, transport, next-preview, history,
 *     natural-end advance, and the listening heartbeat are exercised by the
 *     backend/provider tests and the real-media project, not here.
 *   - Concurrency/idempotency-replay, teardown/reference barriers, auto-
 *     subscription watermarking, CompletionFailed/reconciliation-Retry paths,
 *     and the strict Presence/decoder contracts — all backend/provider tests.
 */

const SEED_DIR = path.join(__dirname, "..", ".seed");

type ConsumptionState = "Unread" | "InProgress" | "Finished";

interface LecternItem {
  itemId: string;
  mediaId: string;
  title: string;
  href: string;
  consumption: { state: ConsumptionState; progress: unknown };
  activation: { kind: "FooterAudio" | "Readable" | "OpenPane" };
}

type Placement =
  | { kind: "First" }
  | { kind: "Last" }
  | { kind: "After"; itemId: string };

/** A stable Readable web article (kind=web_article → activation Readable). */
const READABLE_ARTICLE = {
  file: "non-pdf-media.json",
  field: "media_id",
  title: "E2E linked-items web article seed",
} as const;
/** A second fully-rendered Readable web article used as the background add. */
const READABLE_RESUME = {
  file: "reader-resume-media.json",
  field: "web_media_id",
  title: "E2E reader resume web seed",
} as const;
/** A video (kind=video → activation OpenPane) for the mixed-media dimension. */
const VIDEO_OPENPANE = {
  file: "youtube-media.json",
  field: "playback_only_media_id",
  title: "E2E YouTube playback-only seed",
} as const;

function readSeedMediaId(seed: { file: string; field: string }): string {
  const parsed = JSON.parse(
    readFileSync(path.join(SEED_DIR, seed.file), "utf-8"),
  ) as Record<string, unknown>;
  const value = parsed[seed.field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Seed ${seed.file} is missing string field ${seed.field}`);
  }
  return value;
}

function lecternDeviceId(testInfo: TestInfo, suffix = ""): string {
  return workspaceE2eDeviceId(testInfo, `e2e-lectern${suffix}`);
}

function escapeRegExp(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function expectOk(
  response: { ok(): boolean; status(): number; statusText(): string; text(): Promise<string> },
  label: string,
): Promise<void> {
  if (response.ok()) return;
  const body = await response.text().catch(() => "<no body>");
  throw new Error(
    `${label} failed: ${response.status()} ${response.statusText()} ${body.slice(0, 400)}`,
  );
}

async function getLecternItems(request: APIRequestContext): Promise<LecternItem[]> {
  const response = await request.get("/api/lectern");
  await expectOk(response, "GET /api/lectern");
  const payload = (await response.json()) as { data: { items: LecternItem[] } };
  return payload.data.items;
}

async function placeItems(
  request: APIRequestContext,
  mediaIds: string[],
  placement: Placement,
): Promise<void> {
  const response = await request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: { kind: "PlaceItems", clientMutationId: randomUUID(), mediaIds, placement },
  });
  await expectOk(response, `PlaceItems([${mediaIds.join(", ")}], ${placement.kind})`);
}

async function removeItem(request: APIRequestContext, itemId: string): Promise<void> {
  const response = await request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: { kind: "RemoveItem", clientMutationId: randomUUID(), itemId },
  });
  await expectOk(response, `RemoveItem(${itemId})`);
}

async function setUnread(request: APIRequestContext, mediaId: string): Promise<void> {
  const response = await request.post("/api/consumption/commands", {
    headers: stateChangingApiHeaders(),
    data: { kind: "SetUnread", clientMutationId: randomUUID(), mediaId },
  });
  await expectOk(response, `SetUnread(${mediaId})`);
}

/** Reset to a known-empty Lectern so each test is deterministic and retryable. */
async function clearLectern(request: APIRequestContext): Promise<void> {
  for (const item of await getLecternItems(request)) {
    await removeItem(request, item.itemId);
  }
}

function lecternList(page: Page): Locator {
  return activeWorkspacePane(page).getByRole("list", { name: "Lectern" });
}

function lecternRow(page: Page, title: string): Locator {
  return lecternList(page).getByRole("listitem").filter({ hasText: title });
}

/** Fire the window event the provider revalidates on, as the browser would. */
async function dispatchWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

const player = (page: Page): Locator =>
  page.getByRole("region", { name: "Media player" });

test.describe("lectern + global player lifecycle", () => {
  // One authenticated seed user; these tests mutate shared user-scoped Lectern
  // rows, so they run in order and each restores a clean baseline.
  test.describe.configure({ mode: "serial" });

  const articleId = readSeedMediaId(READABLE_ARTICLE);
  const resumeId = readSeedMediaId(READABLE_RESUME);
  const videoId = readSeedMediaId(VIDEO_OPENPANE);

  test.beforeEach(async ({ request }) => {
    await clearLectern(request);
  });

  test.afterEach(async ({ request }) => {
    // Best-effort: leave no durable Lectern rows and no lingering Finished state
    // for the shared seed media (never mask a real test failure).
    try {
      await clearLectern(request);
      await setUnread(request, articleId);
    } catch (error) {
      console.warn(`[lectern-player] afterEach cleanup skipped: ${String(error)}`);
    }
  });

  test("edits a mixed-media Lectern optimistically; no dock without an audio session", async ({
    page,
  }, testInfo) => {
    test.slow();
    const deviceId = lecternDeviceId(testInfo);

    // (e) Fresh shell, no audio ever played → the activity-conditional dock is
    // absent (spec §1 "reload restores no session"; §6 dock is Absent-gated).
    await gotoSinglePaneWorkspace(page, deviceId, `/media/${articleId}`);
    await expect(player(page)).toHaveCount(0);

    // (a) Add the Readable article from a product surface: the media pane header
    // "Options" menu → "Add to Lectern".
    const mediaPane = activeWorkspacePane(page);
    await mediaPane.getByRole("button", { name: "Options" }).click();
    await page.getByRole("menuitem", { name: "Add to Lectern" }).click();
    await expect(page.getByText("Added to Lectern")).toBeVisible();
    await expect
      .poll(async () => (await getLecternItems(page.request)).some((i) => i.mediaId === articleId))
      .toBe(true);

    // Seed the rest of the mixed-media block (a second Readable + a video) via
    // the same command port. Order is now [article, resume, video].
    await placeItems(page.request, [resumeId, videoId], { kind: "Last" });

    // (b) Open the one Lectern editor and confirm it lists the block in order.
    await gotoSinglePaneWorkspace(page, deviceId, "/lectern");
    const list = lecternList(page);
    await expect(list.getByRole("listitem")).toHaveText([
      escapeRegExp(READABLE_ARTICLE.title),
      escapeRegExp(READABLE_RESUME.title),
      escapeRegExp(VIDEO_OPENPANE.title),
    ]);

    // Server-derived activation + consumption: web article → Readable/Unread,
    // video → OpenPane. Never a FooterAudio (video never becomes audio, §8.14).
    const items = await getLecternItems(page.request);
    const byMedia = new Map(items.map((i) => [i.mediaId, i]));
    expect(byMedia.get(articleId)?.activation.kind).toBe("Readable");
    expect(byMedia.get(articleId)?.consumption.state).toBe("Unread");
    expect(byMedia.get(articleId)?.href).toBe(`/media/${articleId}`);
    expect(byMedia.get(videoId)?.activation.kind).toBe("OpenPane");
    expect(items.every((i) => i.activation.kind !== "FooterAudio")).toBe(true);

    // A Readable row offers Remove but no footer "Play" (Play is FooterAudio-only).
    const articleRow = lecternRow(page, READABLE_ARTICLE.title);
    await articleRow.hover();
    await articleRow.getByRole("button", { name: /^Actions for / }).click();
    await expect(page.getByRole("menuitem", { name: "Remove from Lectern" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Play" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // (c) Reorder with optimistic UI: the drag handle's keyboard affordance moves
    // the article down one slot; the DOM reflects it before the server responds.
    await articleRow
      .getByRole("button", { name: `Reorder ${READABLE_ARTICLE.title}` })
      .press("ArrowDown");
    await expect(list.getByRole("listitem")).toHaveText([
      escapeRegExp(READABLE_RESUME.title),
      escapeRegExp(READABLE_ARTICLE.title),
      escapeRegExp(VIDEO_OPENPANE.title),
    ]);
    await expect
      .poll(async () => (await getLecternItems(page.request)).map((i) => i.mediaId))
      .toEqual([resumeId, articleId, videoId]);

    // (c) Remove with optimistic UI: the middle row disappears immediately, and
    // the canonical snapshot confirms it (Remove is not completion, §3.2/§8.2).
    const removeRow = lecternRow(page, READABLE_ARTICLE.title);
    await removeRow.hover();
    await removeRow.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Remove from Lectern" }).click();
    await expect(list.getByRole("listitem")).toHaveText([
      escapeRegExp(READABLE_RESUME.title),
      escapeRegExp(VIDEO_OPENPANE.title),
    ]);
    await expect
      .poll(async () => (await getLecternItems(page.request)).map((i) => i.mediaId))
      .toEqual([resumeId, videoId]);

    // The dock never appeared during any list edit (no audio session was created).
    await expect(player(page)).toHaveCount(0);
  });

  test("reader Mark as finished removes the exact row; Undo restores it Unread with a new itemId", async ({
    page,
  }, testInfo) => {
    test.slow();
    const deviceId = lecternDeviceId(testInfo, "-finish");

    await placeItems(page.request, [articleId], { kind: "Last" });
    const original = (await getLecternItems(page.request)).find((i) => i.mediaId === articleId);
    expect(original, "article should be On Lectern after placing").toBeTruthy();
    const originalItemId = original!.itemId;
    expect(original!.consumption.state).toBe("Unread");

    // Open the reader FROM the Lectern (SPA nav preserves the shell provider's
    // snapshot, so Mark-finished resolves the exact itemId deterministically).
    await gotoSinglePaneWorkspace(page, deviceId, "/lectern");
    await lecternRow(page, READABLE_ARTICLE.title)
      .getByRole("link", { name: READABLE_ARTICLE.title })
      .click();
    const mediaPane = activeWorkspacePane(page);
    await expect(mediaPane.getByRole("button", { name: "Options" })).toBeVisible();

    // (d) "Mark as finished" → finishLecternItem(nextCapability=Stop): writes
    // Finished, removes ONLY that exact row, offers a 10s Undo (§1 table, §6).
    await mediaPane.getByRole("button", { name: "Options" }).click();
    await page.getByRole("menuitem", { name: "Mark as finished" }).click();
    const undoToast = page.getByRole("status").filter({ hasText: "Marked as finished" });
    await expect(undoToast).toBeVisible();
    await expect
      .poll(async () => (await getLecternItems(page.request)).some((i) => i.itemId === originalItemId))
      .toBe(false);

    // Undo serializes SetUnread + PlaceItems: the media returns Unread under a
    // BRAND-NEW itemId (removal+re-add mints a new id, §3.2 invariant 3).
    await undoToast.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => {
        const restored = (await getLecternItems(page.request)).find((i) => i.mediaId === articleId);
        if (!restored) return null;
        return { newId: restored.itemId !== originalItemId, state: restored.consumption.state };
      })
      .toEqual({ newId: true, state: "Unread" });
  });

  test("focus revalidation discovers a background Lectern addition after the coalescing window", async ({
    page,
  }, testInfo) => {
    test.slow();
    const deviceId = lecternDeviceId(testInfo, "-focus");

    await placeItems(page.request, [articleId], { kind: "Last" });
    await gotoSinglePaneWorkspace(page, deviceId, "/lectern");
    const list = lecternList(page);
    await expect(list.getByRole("listitem")).toHaveCount(1);

    // A background addition lands (as if from another device/worker) — the live
    // provider has not yet observed it and, within the window, focus won't refetch.
    await placeItems(page.request, [resumeId], { kind: "Last" });

    // Fake time (installed after the page is interactive, so load never races a
    // paused timer) to cross LECTERN_REVALIDATE_MIN_INTERVAL_MS (60s) without a
    // real wait. Past the window, a focus transition runs one coalesced
    // revalidation GET that installs the canonical snapshot and surfaces the
    // background addition (§6 revalidate-on-focus; §8.10).
    await page.clock.install();
    await page.clock.fastForward(65_000);
    await dispatchWindowFocus(page);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(lecternRow(page, READABLE_RESUME.title)).toBeVisible();
  });
});
