import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
  workspacePaneButton,
} from "./workspace";
import { stateChangingApiHeaders } from "./api";

interface ReaderResumeSeed {
  web_media_id: string;
  web_anchor_text: string;
  epub_media_id: string;
  epub_chapter_titles: string[];
  pdf_media_id: string;
  pdf_page_count: number;
}

interface YouTubeMediaSeed {
  media_id: string;
  playback_only_media_id: string;
  seek_segment_text: string;
}

interface ReaderTextLocations {
  text_offset: number | null;
  progression: number | null;
  total_progression: number | null;
  position: number | null;
}

interface ReaderTextQuote {
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
}

interface WebReaderResumeState {
  kind: "web";
  target: { fragment_id: string };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface TranscriptReaderResumeState {
  kind: "transcript";
  target: { fragment_id: string };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface EpubReaderResumeState {
  kind: "epub";
  target: {
    section_id: string;
    href_path: string;
    anchor_id: string | null;
  };
  locations: ReaderTextLocations;
  text: ReaderTextQuote;
}

interface PdfReaderResumeState {
  kind: "pdf";
  page: number;
  page_progression: number | null;
  zoom: number | null;
  position: number | null;
}

type ReaderResumeState =
  | WebReaderResumeState
  | TranscriptReaderResumeState
  | EpubReaderResumeState
  | PdfReaderResumeState;

type ReaderCursorSnapshot =
  | { state: "Empty"; revision: 0 }
  | { state: "Positioned"; revision: number; locator: ReaderResumeState };

interface EpubNavigationResponse {
  data: {
    sections: Array<{
      section_id: string;
      label: string;
      href_path: string | null;
    }>;
  };
}

const AUTH_STATE_PATH = path.join(__dirname, "..", ".auth", "user.json");

function readReaderResumeSeed(): ReaderResumeSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "reader-resume-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as ReaderResumeSeed;
}

function readYouTubeSeed(): YouTubeMediaSeed {
  const seedPath = path.join(__dirname, "..", ".seed", "youtube-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8")) as YouTubeMediaSeed;
}

async function fetchReaderCursor(
  request: APIRequestContext,
  mediaId: string,
): Promise<ReaderCursorSnapshot> {
  const response = await request.get(`/api/media/${mediaId}/reader-state`);
  expect(response.ok()).toBeTruthy();
  // The BFF stamps every reader-state response non-cacheable.
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const payload = (await response.json()) as { data: ReaderCursorSnapshot };
  return payload.data;
}

/** Conditional enveloped write: GET the current revision, then replace. */
async function writeReaderCursor(
  request: APIRequestContext,
  mediaId: string,
  locator: ReaderResumeState,
): Promise<ReaderCursorSnapshot> {
  const current = await fetchReaderCursor(request, mediaId);
  const response = await request.put(`/api/media/${mediaId}/reader-state`, {
    data: { cursor: { locator, base_revision: current.revision } },
    headers: stateChangingApiHeaders(),
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { data: ReaderCursorSnapshot };
  return payload.data;
}

async function cursorRevision(
  request: APIRequestContext,
  mediaId: string,
): Promise<number> {
  return (await fetchReaderCursor(request, mediaId)).revision;
}

async function findEpubSectionIdByLabel(
  request: APIRequestContext,
  mediaId: string,
  label: string,
): Promise<{ section_id: string; href_path: string }> {
  const response = await request.get(`/api/media/${mediaId}/navigation`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as EpubNavigationResponse;
  const section = payload.data.sections.find((item) => item.label === label);
  if (!section?.href_path) {
    throw new Error(`Expected EPUB section with label "${label}" and href_path.`);
  }
  return { section_id: section.section_id, href_path: section.href_path };
}

function epubLocatorForSection(section: {
  section_id: string;
  href_path: string;
}): EpubReaderResumeState {
  return {
    kind: "epub",
    target: {
      section_id: section.section_id,
      href_path: section.href_path,
      anchor_id: null,
    },
    locations: {
      text_offset: 0,
      progression: 0,
      total_progression: null,
      position: null,
    },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  };
}

function progressDeviceId(testInfo: TestInfo, suffix = ""): string {
  return workspaceE2eDeviceId(testInfo, `e2e-reader-progress${suffix}`);
}

/**
 * A cursor-bearing PUT total is stable only once nothing is in flight and none
 * has started for a window well past the 500 ms save debounce — otherwise a
 * trailing debounced save could still land after the count is read.
 */
async function awaitCursorWriteQuiescence(tracker: {
  inFlight: number;
  lastStartedAt: number;
}): Promise<void> {
  const quietWindowMs = 900;
  await expect
    .poll(
      () =>
        tracker.inFlight === 0 &&
        Date.now() - tracker.lastStartedAt >= quietWindowMs,
      { timeout: 20_000 },
    )
    .toBe(true);
}

function pdfControlsToolbar(page: Page) {
  return activeWorkspacePane(page)
    .getByRole("toolbar", { name: "PDF controls" })
    .first();
}

function pageIndicator(page: Page, pageNumber: number, pageCount: number) {
  return pdfControlsToolbar(page)
    .locator(`[aria-label="Page ${pageNumber} of ${pageCount}"]`)
    .first();
}

async function clickPdfControl(page: Page, ariaLabel: string): Promise<void> {
  const toolbar = pdfControlsToolbar(page);
  await expect(toolbar).toBeVisible();

  const inlineButton = toolbar.getByRole("button", { name: ariaLabel }).first();
  if (
    (await inlineButton.count()) > 0 &&
    (await inlineButton.isVisible().catch(() => false))
  ) {
    await expect(inlineButton).toBeEnabled();
    await inlineButton.click();
    return;
  }

  const overflowToggle = toolbar
    .getByRole("button", { name: "More actions" })
    .first();
  await expect(overflowToggle).toBeVisible();
  await overflowToggle.click();

  const menuItem = page.getByRole("menuitem", { name: ariaLabel }).first();
  await expect(menuItem).toBeVisible();
  await expect(menuItem).toBeEnabled();
  await menuItem.click();
}

async function readRenderedPageScale(
  page: Page,
  pageNumber: number,
): Promise<number | null> {
  const pageSurface = activeWorkspacePane(page)
    .locator(`[data-testid="pdf-page-surface-${pageNumber}"]`)
    .first();
  await expect(pageSurface).toBeVisible();
  const raw = await pageSurface.getAttribute("data-nexus-page-scale");
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

async function reloadWorkspacePage(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(activeWorkspacePane(page)).toBeVisible({ timeout: 15_000 });
}

/** Fire the events the coordinator revalidates on, as the browser would. */
async function dispatchWindowEvent(page: Page, type: "focus" | "blur"): Promise<void> {
  await page.evaluate((eventType) => {
    window.dispatchEvent(new Event(eventType));
  }, type);
}

async function openPhoneContext(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe("reader progress continuity", () => {
  test.describe.configure({ mode: "serial" });

  test("web article resumes canonical position on the bare route after reflow and reload", async ({
    page,
  }, testInfo) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.web_media_id;
    const profileResponse = await page.request.get("/api/me/reader-profile");
    const baseline = ((await profileResponse.json()) as {
      data: { font_size_px: number };
    }).data;
    const targetFontSize = baseline.font_size_px === 24 ? 20 : 24;

    try {
      await gotoSinglePaneWorkspace(
        page,
        progressDeviceId(testInfo),
        `/media/${mediaId}`,
      );
      const activePane = activeWorkspacePane(page);
      await expect(
        activePane.getByText("reader resume paragraph 001"),
      ).toBeVisible({ timeout: 15_000 });

      const anchor = activePane.getByText(seed.web_anchor_text).first();
      await anchor.scrollIntoViewIfNeeded();

      await expect
        .poll(async () => {
          const snapshot = await fetchReaderCursor(page.request, mediaId);
          return snapshot.state === "Positioned" && snapshot.locator.kind === "web"
            ? (snapshot.locator.locations.text_offset ?? 0)
            : 0;
        })
        .toBeGreaterThan(0);
      const saved = await fetchReaderCursor(page.request, mediaId);
      expect(saved.state).toBe("Positioned");
      expect(saved.revision).toBeGreaterThanOrEqual(1);

      // Reflow: canonical offsets survive font-size changes; pixels do not.
      const patch = await page.request.patch("/api/me/reader-profile", {
        data: { font_size_px: targetFontSize },
        headers: stateChangingApiHeaders(),
      });
      expect(patch.ok()).toBeTruthy();

      await reloadWorkspacePage(page);
      await expect(page.getByText("reader resume paragraph 001")).toBeVisible({
        timeout: 15_000,
      });
      await expect(anchor).toBeInViewport();
      // The bare route never projects progress into the URL.
      expect(page.url()).not.toMatch(/[?&](loc|fragment)=/);
    } finally {
      const restore = await page.request.patch("/api/me/reader-profile", {
        data: { font_size_px: baseline.font_size_px },
        headers: stateChangingApiHeaders(),
      });
      expect(restore.ok()).toBeTruthy();
    }
  });

  test("epub TOC navigation persists and the bare route resumes it", async ({
    page,
  }, testInfo) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.epub_media_id;
    const chapterTwo = seed.epub_chapter_titles[1];
    const chapterTwoSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterTwo,
    );

    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    const activePane = activeWorkspacePane(page);
    const sectionSelect = activePane.getByLabel("Select section");
    await expect(sectionSelect).toBeVisible();
    await sectionSelect.selectOption({ label: chapterTwo });
    await expect(
      activePane.getByRole("heading", { name: chapterTwo }),
    ).toBeVisible({ timeout: 10_000 });

    // Direct TOC commands are genuine input: they become durable progress.
    await expect
      .poll(async () => {
        const snapshot = await fetchReaderCursor(page.request, mediaId);
        return snapshot.state === "Positioned" && snapshot.locator.kind === "epub"
          ? snapshot.locator.target.section_id
          : null;
      })
      .toBe(chapterTwoSection.section_id);

    await reloadWorkspacePage(page);
    await expect(
      activeWorkspacePane(page).getByRole("heading", { name: chapterTwo }),
    ).toBeVisible({ timeout: 15_000 });
    expect(page.url()).not.toMatch(/[?&](loc|fragment)=/);
  });

  test("cold coarse ?loc loses to the canonical cursor and the URL is repaired", async ({
    page,
  }, testInfo) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.epub_media_id;
    const chapterOne = seed.epub_chapter_titles[0];
    const chapterTwo = seed.epub_chapter_titles[1];
    const chapterOneSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterOne,
    );
    const chapterTwoSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterTwo,
    );
    await writeReaderCursor(
      page.request,
      mediaId,
      epubLocatorForSection(chapterTwoSection),
    );
    const revisionBefore = await cursorRevision(page.request, mediaId);

    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}?loc=${encodeURIComponent(chapterOneSection.section_id)}`,
    );
    const activePane = activeWorkspacePane(page);
    await expect(
      activePane.getByRole("heading", { name: chapterTwo }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.url())
      .not.toMatch(/[?&](loc|fragment)=/);

    // Losing to the cursor writes nothing.
    await page.waitForTimeout(1_500);
    expect(await cursorRevision(page.request, mediaId)).toBe(revisionBefore);
  });

  test("reader location churn stays out of pane history: one Back reaches the origin and Forward re-enters at the canonical cursor", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readReaderResumeSeed();
    const mediaId = seed.epub_media_id;
    const chapterOne = seed.epub_chapter_titles[0];
    const chapterTwo = seed.epub_chapter_titles[1];
    const chapterThree = seed.epub_chapter_titles[2];
    const chapterOneSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterOne,
    );
    const chapterThreeSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterThree,
    );

    // Acceptance starts from isolated seeded cursor state: pinning chapter one
    // makes the fresh mount deterministic so every churn step is a real change.
    await writeReaderCursor(
      page.request,
      mediaId,
      epubLocatorForSection(chapterOneSection),
    );

    // Cursor-bearing saves are the only writes traversal must never emit; track
    // PUT starts and in-flight count so a recorded total can be proven quiescent.
    // The reader-state endpoint also receives attention-only lifecycle-flush PUTs
    // on unmount (see useReaderProgress.ts's lifecycleFlush) — those carry an
    // `attention` field but no `cursor` field, so pane Back would otherwise emit
    // one and falsely look like traversal wrote a cursor. Filter by body shape.
    const cursorWrites = { started: 0, inFlight: 0, lastStartedAt: 0 };
    const isCursorWrite = (request: Request) => {
      if (
        request.method() !== "PUT" ||
        new URL(request.url()).pathname !== `/api/media/${mediaId}/reader-state`
      ) {
        return false;
      }
      const body = request.postData();
      if (!body) return false;
      try {
        const parsed: unknown = JSON.parse(body);
        return (
          typeof parsed === "object" && parsed !== null && "cursor" in parsed
        );
      } catch {
        return false;
      }
    };
    page.on("request", (request) => {
      if (!isCursorWrite(request)) return;
      cursorWrites.started += 1;
      cursorWrites.inFlight += 1;
      cursorWrites.lastStartedAt = Date.now();
    });
    const settleCursorWrite = (request: Request) => {
      if (!isCursorWrite(request)) return;
      cursorWrites.inFlight = Math.max(0, cursorWrites.inFlight - 1);
    };
    page.on("requestfinished", settleCursorWrite);
    page.on("requestfailed", settleCursorWrite);

    // The seeded non-media structural origin; reader churn must never evict it.
    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
      { history: { back: ["/libraries"], forward: [] } },
    );
    const activePane = activeWorkspacePane(page);
    const sectionSelect = activePane.getByLabel("Select section");
    await expect(sectionSelect).toBeVisible({ timeout: 15_000 });
    await expect(
      activePane.getByRole("heading", { name: chapterOne }),
    ).toBeVisible({ timeout: 15_000 });

    // A reader remount would recreate the viewport and drop this token; the
    // churn must preserve the one mounted reader instance.
    const readerViewport = activePane.getByTestId("document-viewport").first();
    await readerViewport.evaluate((element) => {
      element.setAttribute("data-e2e-mount-token", "epub-churn");
    });

    // Fourteen reader-local section changes exceed the 12-entry stack budget;
    // each replaces the mounted visit rather than pushing a checkpoint.
    const churnTargets = Array.from({ length: 14 }, (_, index) =>
      index % 2 === 0 ? chapterTwo : chapterThree,
    );
    for (const label of churnTargets) {
      await sectionSelect.selectOption({ label });
      await expect(
        activePane.getByRole("heading", { name: label }),
      ).toBeVisible({ timeout: 10_000 });
    }

    // While mounted, replace publishes the latest coarse target and never remounts.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("loc"))
      .toBe(chapterThreeSection.section_id);
    await expect(readerViewport).toHaveAttribute(
      "data-e2e-mount-token",
      "epub-churn",
    );

    const backButton = activePane.getByRole("button", {
      name: "Go back in this pane",
    });
    const forwardButton = activePane.getByRole("button", {
      name: "Go forward in this pane",
    });
    await expect(backButton).toBeEnabled();

    // Genuine section input becomes durable progress; let chapter three reach
    // the server and its writes quiesce before proving traversal is silent.
    await expect
      .poll(async () => {
        const snapshot = await fetchReaderCursor(page.request, mediaId);
        return snapshot.state === "Positioned" && snapshot.locator.kind === "epub"
          ? snapshot.locator.target.section_id
          : null;
      })
      .toBe(chapterThreeSection.section_id);
    await awaitCursorWriteQuiescence(cursorWrites);
    const writesAfterChurn = cursorWrites.started;
    const revisionAtChapterThree = await cursorRevision(page.request, mediaId);

    // Guard against vacuous quiescence: the churn above must actually have
    // produced at least one cursor-bearing write before we assert traversal
    // adds none.
    expect(cursorWrites.started).toBeGreaterThan(0);

    // One Back reaches the origin: the churn left a single checkpoint, not a
    // flooded stack that evicted /libraries.
    await backButton.click();
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(
      activePane.getByRole("heading", { name: chapterThree }),
    ).toHaveCount(0);
    await expect(activePane.getByTestId("document-viewport")).toHaveCount(0);

    // Forward remounts the media; a Positioned cursor supersedes the coarse
    // target, so the proof is rendered chapter three, never the ?loc query.
    await forwardButton.click();
    await expect(
      activeWorkspacePane(page).getByRole("heading", { name: chapterThree }),
    ).toBeVisible({ timeout: 15_000 });

    // Deterministic discriminator (AC4): after the Forward remount, normal
    // cursor precedence and URL repair apply — the Positioned cursor must
    // repair the URL to the bare media route. Rendered chapter three alone is
    // ambiguous here (forward href loc === cursor === chapter three); this
    // observably fails if precedence/repair breaks.
    await expect
      .poll(() => page.url())
      .not.toMatch(/[?&](loc|fragment)=/);

    // Traversal emits no new cursor-bearing write or revision.
    await awaitCursorWriteQuiescence(cursorWrites);
    expect(cursorWrites.started).toBe(writesAfterChurn);
    expect(await cursorRevision(page.request, mediaId)).toBe(
      revisionAtChapterThree,
    );

    // Exactly one checkpoint: a second Back returns straight to the origin.
    await activeWorkspacePane(page)
      .getByRole("button", { name: "Go back in this pane" })
      .click();
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(
      activeWorkspacePane(page).getByTestId("document-viewport"),
    ).toHaveCount(0);

    // Later genuine input still persists: Forward to the media, change section
    // once, and the canonical revision advances past the traversal-stable value.
    await activeWorkspacePane(page)
      .getByRole("button", { name: "Go forward in this pane" })
      .click();
    const resumedPane = activeWorkspacePane(page);
    await expect(
      resumedPane.getByRole("heading", { name: chapterThree }),
    ).toBeVisible({ timeout: 15_000 });
    const resumedSectionSelect = resumedPane.getByLabel("Select section");
    await expect(resumedSectionSelect).toBeVisible({ timeout: 15_000 });
    await resumedSectionSelect.selectOption({ label: chapterTwo });
    await expect(
      resumedPane.getByRole("heading", { name: chapterTwo }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => cursorRevision(page.request, mediaId))
      .toBeGreaterThan(revisionAtChapterThree);
  });

  test("pdf resumes page and zoom after reload without remounting on page changes", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readReaderResumeSeed();
    const mediaId = seed.pdf_media_id;
    const expectedPageCount = seed.pdf_page_count;
    let fileRequestCount = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/media/${mediaId}/file`) {
        fileRequestCount += 1;
      }
    });

    await writeReaderCursor(page.request, mediaId, {
      kind: "pdf",
      position: 1,
      page: 1,
      page_progression: null,
      zoom: 1,
    });

    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    await expect(pageIndicator(page, 1, expectedPageCount)).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(() => fileRequestCount).toBeGreaterThan(0);
    const initialFileRequestCount = fileRequestCount;

    await clickPdfControl(page, "Next page");
    await clickPdfControl(page, "Next page");
    await expect(pageIndicator(page, 3, expectedPageCount)).toBeVisible({
      timeout: 10_000,
    });

    const scaleBeforeZoom = await readRenderedPageScale(page, 3);
    expect(scaleBeforeZoom).not.toBeNull();
    await clickPdfControl(page, "Zoom in");
    await expect
      .poll(async () => {
        const scaleAfterZoom = await readRenderedPageScale(page, 3);
        return scaleAfterZoom !== null && scaleBeforeZoom !== null
          ? scaleAfterZoom > scaleBeforeZoom
          : null;
      })
      .toBe(true);

    await expect
      .poll(async () => {
        const snapshot = await fetchReaderCursor(page.request, mediaId);
        return snapshot.state === "Positioned" && snapshot.locator.kind === "pdf"
          ? { page: snapshot.locator.page, zoom: snapshot.locator.zoom }
          : null;
      })
      .toEqual({ page: 3, zoom: 1.25 });

    // Page/zoom navigation never re-opened the document.
    expect(fileRequestCount).toBe(initialFileRequestCount);

    await reloadWorkspacePage(page);
    await expect(pageIndicator(page, 3, expectedPageCount)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => {
        const scaleAfterReload = await readRenderedPageScale(page, 3);
        return scaleAfterReload !== null && scaleBeforeZoom !== null
          ? scaleAfterReload > scaleBeforeZoom
          : null;
      })
      .toBe(true);

    // Later addressable application: a newer remote cursor changes the page
    // on the live viewer — no remount, no document re-open.
    const fileRequestsAfterReload = fileRequestCount;
    await dispatchWindowEvent(page, "blur");
    await writeReaderCursor(page.request, mediaId, {
      kind: "pdf",
      position: 5,
      page: 5,
      page_progression: null,
      zoom: 1.25,
    });
    await dispatchWindowEvent(page, "focus");
    await expect(pageIndicator(page, 5, expectedPageCount)).toBeVisible({
      timeout: 15_000,
    });
    expect(fileRequestCount).toBe(fileRequestsAfterReload);
  });

  test("transcript resumes its canonical fragment on the bare route", async ({
    page,
  }, testInfo) => {
    const youtube = readYouTubeSeed();
    const mediaId = youtube.media_id;

    // Establish the canonical cursor at the seek segment's fragment.
    const fragmentsResponse = await page.request.get(
      `/api/media/${mediaId}/fragments`,
    );
    expect(fragmentsResponse.ok()).toBeTruthy();
    const fragments = ((await fragmentsResponse.json()) as {
      data: Array<{ id: string; canonical_text: string }>;
    }).data;
    const seekFragment = fragments.find((fragment) =>
      fragment.canonical_text.includes(youtube.seek_segment_text),
    );
    expect(seekFragment).toBeTruthy();
    if (!seekFragment) {
      throw new Error("Expected the seeded seek segment fragment.");
    }
    await writeReaderCursor(page.request, mediaId, {
      kind: "transcript",
      target: { fragment_id: seekFragment.id },
      locations: {
        text_offset: 0,
        progression: 0,
        total_progression: null,
        position: null,
      },
      text: { quote: null, quote_prefix: null, quote_suffix: null },
    });

    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    const activePane = activeWorkspacePane(page);
    await expect(
      activePane
        .locator('[aria-current="true"]')
        .filter({ hasText: youtube.seek_segment_text }),
    ).toBeVisible({ timeout: 15_000 });
    expect(page.url()).not.toMatch(/[?&](loc|fragment)=/);
  });

  test("non-readable media makes no reader-progress request", async ({
    page,
  }, testInfo) => {
    const youtube = readYouTubeSeed();
    const mediaId = youtube.playback_only_media_id;
    let readerStateRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/media/${mediaId}/reader-state`) {
        readerStateRequests += 1;
      }
    });

    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    const activePane = activeWorkspacePane(page);
    await expect(activePane).toBeVisible();
    // The normal media pane renders ungated while no progress I/O happens.
    await page.waitForTimeout(1_500);
    expect(readerStateRequests).toBe(0);
  });

  test("clean dormant laptop auto-adopts the phone's newer position without remount", async ({
    page,
    browser,
  }, testInfo) => {
    const seed = readReaderResumeSeed();
    const mediaId = seed.epub_media_id;
    const chapterOne = seed.epub_chapter_titles[0];
    const chapterThree = seed.epub_chapter_titles[2];
    const chapterOneSection = await findEpubSectionIdByLabel(
      page.request,
      mediaId,
      chapterOne,
    );
    await writeReaderCursor(
      page.request,
      mediaId,
      epubLocatorForSection(chapterOneSection),
    );

    // Desktop laptop: open at chapter one, then go dormant.
    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    const desktopPane = activeWorkspacePane(page);
    await expect(
      desktopPane.getByRole("heading", { name: chapterOne }),
    ).toBeVisible({ timeout: 15_000 });
    await dispatchWindowEvent(page, "blur");

    // Phone: read on to chapter three.
    const phone = await openPhoneContext(browser);
    try {
      await gotoSinglePaneWorkspace(
        phone.page,
        progressDeviceId(testInfo, "-phone"),
        `/media/${mediaId}`,
      );
      const phonePane = activeWorkspacePane(phone.page);
      const sectionSelect = phonePane.getByLabel("Select section");
      await expect(sectionSelect).toBeVisible({ timeout: 15_000 });
      await sectionSelect.selectOption({ label: chapterThree });
      await expect(
        phonePane.getByRole("heading", { name: chapterThree }),
      ).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => {
          const snapshot = await fetchReaderCursor(phone.page.request, mediaId);
          return snapshot.state === "Positioned" && snapshot.locator.kind === "epub"
            ? snapshot.locator.target.section_id
            : null;
        })
        .not.toBe(chapterOneSection.section_id);
    } finally {
      await phone.context.close();
    }

    // Laptop returns: clean dormant re-entry auto-applies without remount.
    await dispatchWindowEvent(page, "focus");
    await expect(
      desktopPane.getByRole("heading", { name: chapterThree }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Resumed from your most recent position."),
    ).toBeAttached();
    expect(page.url()).not.toMatch(/[?&](loc|fragment)=/);
  });

  test("active laptop gets the handoff; Stay makes the local viewport canonical, Go adopts without a write", async ({
    page,
    browser,
  }, testInfo) => {
    test.slow();

    const seed = readReaderResumeSeed();
    const mediaId = seed.web_media_id;

    // Desktop laptop: genuine reading commits a position and stays active.
    await gotoSinglePaneWorkspace(
      page,
      progressDeviceId(testInfo),
      `/media/${mediaId}`,
    );
    const desktopPane = activeWorkspacePane(page);
    await expect(
      desktopPane.getByText("reader resume paragraph 001"),
    ).toBeVisible({ timeout: 15_000 });
    await desktopPane
      .getByText("reader resume paragraph 040")
      .first()
      .scrollIntoViewIfNeeded();
    await expect
      .poll(async () => (await fetchReaderCursor(page.request, mediaId)).revision)
      .toBeGreaterThanOrEqual(1);

    // Phone: read much further, committing a newer revision. While it is
    // still open, the laptop keeps reading: dirty local state means the
    // laptop's now-stale save returns 409 (no silent overwrite) — or, if a
    // revalidation lands first, the dirty reader keeps its viewport with a
    // candidate. Either way the handoff surfaces and nothing teleports.
    const handoff = desktopPane.getByTestId("reader-progress-handoff");
    const phone = await openPhoneContext(browser);
    try {
      await gotoSinglePaneWorkspace(
        phone.page,
        progressDeviceId(testInfo, "-phone"),
        `/media/${mediaId}`,
      );
      const phonePane = activeWorkspacePane(phone.page);
      await expect(
        phonePane.getByText("reader resume paragraph 001"),
      ).toBeVisible({ timeout: 15_000 });
      await phonePane
        .getByText("reader resume paragraph 200")
        .first()
        .scrollIntoViewIfNeeded();
      // Wait until the PHONE's position is canonical (not merely any newer
      // revision — a trailing desktop save could bump the revision too).
      await expect
        .poll(async () => {
          const snapshot = await fetchReaderCursor(phone.page.request, mediaId);
          return snapshot.state === "Positioned" && snapshot.locator.kind === "web"
            ? (snapshot.locator.text.quote ?? "")
            : "";
        })
        .toMatch(/paragraph (19|20)\d/);

      // The dirty target sits outside the current viewport so a genuine
      // scroll (and capture) actually happens.
      await desktopPane
        .getByText("reader resume paragraph 060")
        .first()
        .scrollIntoViewIfNeeded();
      await expect(handoff).toBeVisible({ timeout: 10_000 });
      await expect(
        desktopPane.getByText("reader resume paragraph 060").first(),
      ).toBeInViewport();
    } finally {
      await phone.context.close();
    }

    // Stay at this position: the laptop viewport becomes canonical.
    await handoff
      .getByRole("button", { name: "Stay at this position" })
      .click();
    await expect(handoff).not.toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => {
        const snapshot = await fetchReaderCursor(page.request, mediaId);
        if (snapshot.state !== "Positioned" || snapshot.locator.kind !== "web") {
          return null;
        }
        return snapshot.locator.text.quote ?? "";
      })
      .toMatch(/paragraph 0(5|6)\d/);

    // Phone writes again; this time the laptop adopts the remote position.
    const stayRevision = await cursorRevision(page.request, mediaId);
    const phoneAgain = await openPhoneContext(browser);
    try {
      await gotoSinglePaneWorkspace(
        phoneAgain.page,
        progressDeviceId(testInfo, "-phone-2"),
        `/media/${mediaId}`,
      );
      const phonePane = activeWorkspacePane(phoneAgain.page);
      // A cold mount resumes the canonical (post-Stay) position internally:
      // the paragraph the canonical quote anchors to is in the viewport.
      const canonical = await fetchReaderCursor(page.request, mediaId);
      const canonicalQuote =
        canonical.state === "Positioned" && canonical.locator.kind === "web"
          ? (canonical.locator.text.quote ?? "")
          : "";
      const anchorParagraph = canonicalQuote.match(
        /reader resume paragraph \d{3}/,
      )?.[0];
      if (!anchorParagraph) {
        throw new Error(
          `Canonical quote does not anchor a paragraph: ${canonicalQuote}`,
        );
      }
      await expect(
        phonePane.getByText(anchorParagraph).first(),
      ).toBeInViewport({ timeout: 15_000 });

      await phonePane
        .getByText("reader resume paragraph 230")
        .first()
        .scrollIntoViewIfNeeded();
      await expect
        .poll(async () => {
          const snapshot = await fetchReaderCursor(
            phoneAgain.page.request,
            mediaId,
          );
          return snapshot.state === "Positioned" && snapshot.locator.kind === "web"
            ? (snapshot.locator.text.quote ?? "")
            : "";
        })
        .toMatch(/paragraph 2(2|3)\d/);

      // Dirty the laptop again: the stale save conflicts into a fresh handoff.
      await desktopPane
        .getByText("reader resume paragraph 080")
        .first()
        .scrollIntoViewIfNeeded();
      await expect(handoff).toBeVisible({ timeout: 10_000 });
    } finally {
      await phoneAgain.context.close();
    }

    const revisionBeforeAdopt = await cursorRevision(page.request, mediaId);
    await handoff
      .getByRole("button", { name: "Go to most recent position" })
      .click();
    await expect(
      desktopPane.getByText("reader resume paragraph 230").first(),
    ).toBeInViewport({ timeout: 15_000 });

    // Accepting the remote position produces no write echo.
    await page.waitForTimeout(1_500);
    expect(await cursorRevision(page.request, mediaId)).toBe(revisionBeforeAdopt);
  });
});
