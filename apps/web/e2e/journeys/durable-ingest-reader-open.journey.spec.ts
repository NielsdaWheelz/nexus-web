import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { APIResponse, Locator, Page, TestInfo } from "playwright/test";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import { TOOL_PROJECTION_REVISION } from "@/lib/conversations/toolContractProjection";
import { captureReadableArticle } from "../articleFixture";
import {
  adversarialTruncatedPdf,
  boundedCitationPdf,
  uniqueCanonicalReaderEpub,
} from "../corpus";
import { uploadDocument } from "../documentUploadFixture";
import {
  apiOrigin,
  expect,
  gotoWithStrictCsp,
  minioOrigin,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest, type ExactOriginRequest } from "../request";

test.use({ journeyId: "durable-ingest-reader-open" });

type Presence<T> = { kind: "Absent" } | { kind: "Present"; value: T };

interface ImportItem {
  ref: string;
  title: string;
  media_ref: Presence<string>;
  state:
    | {
        kind: "Active";
        status: "Queued" | "Processing";
        stage: string;
        progress: Presence<
          | { kind: "Stage"; stage: string }
          | {
              kind: "Counted";
              stage: "Extract";
              completed: number;
              total: number;
              unit: "Page" | "Chapter";
            }
        >;
      }
    | {
        kind: "NeedsAttention";
        stage: string;
        failure_code: Presence<string>;
      }
    | { kind: "Complete" };
}

async function readBody(response: APIResponse) {
  const text = await response.text();
  expect(
    response.ok(),
    `Expected ${response.url()} to succeed; status=${response.status()} body=${text.slice(0, 500)}`,
  ).toBeTruthy();
  return JSON.parse(text) as unknown;
}

async function acceptPdfUpload(
  api: ExactOriginRequest,
  objects: ExactOriginRequest,
  payload: Buffer,
  filename: string,
  idempotencyKey: string,
): Promise<{ ref: string; media_id: string; source_attempt_id: string }> {
  const published = await uploadDocument({
    api,
    objects,
    payload,
    kind: "Pdf",
    filename,
    idempotencyKey,
  });
  return {
    ref: `upload:${published.sessionHandle}`,
    media_id: published.mediaId,
    source_attempt_id: published.sourceAttemptId,
  };
}

/** One import as its own owner reports it, addressed by its canonical ref. */
async function importDetail(
  api: ExactOriginRequest,
  ref: string,
): Promise<ImportItem> {
  const response = await api.get(`/api/imports/${encodeURIComponent(ref)}`);
  const payload = (await readBody(response)) as { data: { item: ImportItem } };
  return payload.data.item;
}

async function importsIn(
  api: ExactOriginRequest,
  view: "NeedsAttention" | "InProgress" | "History",
): Promise<ImportItem[]> {
  const response = await api.get(`/api/imports?view=${view}&limit=100`);
  const payload = (await readBody(response)) as { data: { items: ImportItem[] } };
  return payload.data.items;
}

/**
 * The deliberate desktop visual/assistive review the cutover requires: a
 * screenshot and the real accessibility tree at each reviewed state, written
 * beside the run's other artifacts. These are review evidence, not assertions.
 */
async function captureImportsReview(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  const target = testInfo.outputPath("imports-review", `${state}.png`);
  await mkdir(path.dirname(target), { recursive: true });
  await page.screenshot({ path: target, fullPage: false });
  // Narrow viewports swap the rail for the mobile pane bar, so the navigation
  // landmark is recorded when the chrome under review has one.
  const navigation = page.getByRole("navigation").first();
  // Under the mobile breakpoint the inspector is a sheet portalled to the body,
  // so it is outside `main`: a capture of a state whose inspector is open has to
  // record it, or the tree denies what the pixels show.
  const sheet = page.getByRole("dialog", { name: "Import details" });
  // The same is true of the mobile chrome itself: it replaces the rail with a
  // banner pane bar and a fixed switchboard control, and neither is inside
  // `main`, so a narrow capture that recorded only the two landmarks above would
  // photograph controls its tree denies.
  const paneBar = page.getByRole("banner").first();
  const switchboard = page.getByTestId("nexus-wrapper");
  const tree = [
    "# navigation",
    (await navigation.count()) === 0
      ? "(this chrome renders no navigation landmark)"
      : await navigation.ariaSnapshot(),
    ...((await paneBar.count()) === 0
      ? []
      : ["# mobile pane bar", await paneBar.ariaSnapshot()]),
    ...((await switchboard.count()) === 0
      ? []
      : ["# switchboard control", await switchboard.ariaSnapshot()]),
    "# pane",
    await page.getByRole("main").first().ariaSnapshot(),
    ...((await sheet.count()) === 0
      ? []
      : ["# inspector (sheet)", await sheet.ariaSnapshot()]),
  ].join("\n");
  await writeFile(
    testInfo.outputPath("imports-review", `${state}.aria.txt`),
    tree,
    "utf8",
  );
}

test("an accepted EPUB publishes in the default Library and opens through its real row", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  // The bounded-child executor runs each Heavy job in a fresh process, so a
  // document’s ingest/enrich/reindex pipeline plus the fresh-database
  // maintenance backlog needs materially more wall time on CI than the
  // pre-cutover in-process worker.
  test.setTimeout(300_000);
  const api = pageRequest(page, webOrigin);
  const objects = pageRequest(page, minioOrigin);
  const profileResponse = await api.get("/api/me");
  const profileText = await profileResponse.text();
  expect(
    profileResponse.ok(),
    `Default Library lookup for ${journeyUser.id} failed: ${profileResponse.status()} ${profileText.slice(0, 500)}`,
  ).toBeTruthy();
  const defaultLibraryId = (
    JSON.parse(profileText) as { data: { default_library_id: string } }
  ).data.default_library_id;
  const removedInit = await api.post("/api/media/upload/init", {
    headers: { origin: webOrigin },
    data: {},
  });
  expect(
    removedInit.status(),
    "The provisional-media upload route must be absent after the hard cut.",
  ).toBe(404);
  const epub = uniqueCanonicalReaderEpub(journeyUser.id);
  const published = await uploadDocument({
    api,
    objects,
    payload: epub,
    kind: "Epub",
    filename: "canonical-reader-durable-ingest.epub",
    idempotencyKey: `durable-ingest-${journeyUser.id}`,
    beforeConfirm: async ({ session_handle: sessionHandle }) => {
      const pending = await importDetail(api, `upload:${sessionHandle}`);
      expect(
        pending.media_ref.kind,
        "An uploaded but unconfirmed session must not publish media.",
      ).toBe("Absent");
      expect(
        pending.state.kind,
        "An uploaded but unconfirmed session is work in progress, not an obligation on the reader.",
      ).toBe("Active");
    },
  });
  const mediaId = published.mediaId;
  const removedConfirm = await api.post(`/api/media/${mediaId}/ingest`, {
    headers: { origin: webOrigin },
    data: {},
  });
  expect(
    removedConfirm.status(),
    "The media-scoped upload confirmation route must be absent after the hard cut.",
  ).toBe(404);

  await expect
    .poll(
      async () => {
        const response = await api.get(
          `/api/media/${mediaId}`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: { processing_status: string };
        };
        return payload.data.processing_status;
      },
      {
        message: `Expected worker-owned media ${mediaId} to reach ready_for_reading.`,
        timeout: 90_000,
      },
    )
    .toBe("ready_for_reading");

  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  const libraryRow = page.locator(
    `main a[href="/media/${mediaId}"]`,
  );
  await expect(
    libraryRow,
    `Worker-owned media ${mediaId} was ready but absent from default Library ${defaultLibraryId}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    libraryRow,
    `Default Library ${defaultLibraryId} published media ${mediaId} without the independently known EPUB title.`,
  ).toHaveAccessibleName("Canonical Reader Positions");
  await libraryRow.click();
  await expect(page).toHaveURL(
    new RegExp(`/media/${mediaId}(?:[?#]|$)`),
  );
  await expect(
    page.getByRole("heading", { name: "Canonical Reader Positions" }),
    `Reader did not project the independently known EPUB title for media ${mediaId}.`,
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "EPUB controls" }),
    `Reader for media ${mediaId} did not publish EPUB navigation.`,
  ).toBeVisible();
  await expect(
    page.getByLabel("Select section"),
    `Reader for media ${mediaId} did not load its persisted EPUB sections.`,
  ).toBeVisible();
});

test("bounded Heavy ingest preserves API and Light-worker service through complete indexing and typed rejection", async ({
  page,
  journeyUser,
}, testInfo) => {
  await signIn(page, journeyUser);
  // The bounded-child executor runs each Heavy job in a fresh process, so a
  // document’s ingest/enrich/reindex pipeline plus the fresh-database
  // maintenance backlog needs materially more wall time on CI than the
  // pre-cutover in-process worker.
  test.setTimeout(300_000);
  const api = pageRequest(page, webOrigin);
  const directApi = pageRequest(page, apiOrigin);
  const objects = pageRequest(page, minioOrigin);
  const chatEvidenceMediaId = await captureReadableArticle(
    page,
    "bounded-interactive-proof",
  );
  const boundedTitle = "bounded-media-processing-evidence-corpus.pdf";
  const bounded = await acceptPdfUpload(
    api,
    objects,
    boundedCitationPdf(),
    boundedTitle,
    `bounded-pdf-${journeyUser.id}`,
  );

  await expect
    .poll(
      async () => {
        const item = await importDetail(api, bounded.ref);
        const progress =
          item.state.kind === "Active" && item.state.progress.kind === "Present"
            ? item.state.progress.value
            : undefined;
        return item.state.kind === "Active" &&
          item.state.status === "Processing" &&
          progress?.kind === "Counted" &&
          progress.unit === "Page" &&
          progress.total === 712 &&
          progress.completed > 0 &&
          progress.completed < progress.total
          ? "active"
          : JSON.stringify(item);
      },
      {
        message: `Heavy source ${bounded.media_id} never exposed in-flight counted 712-page progress.`,
        timeout: 90_000,
      },
    )
    .toBe("active");

  // The API and its authenticated reads keep serving while that Heavy source is
  // still extracting — asserted here, where the poll above has just proved the
  // work is in flight.
  const readiness = await directApi.get("/readyz");
  expect(
    readiness.ok(),
    `API readiness failed during Heavy source ${bounded.media_id}: ${readiness.status()} ${await readiness.text()}`,
  ).toBeTruthy();
  const profile = await api.get("/api/me");
  expect(
    profile.ok(),
    `Authenticated read failed during Heavy source ${bounded.media_id}: ${profile.status()} ${await profile.text()}`,
  ).toBeTruthy();

  // The active Heavy import is real worker-owned state. The rail's Imports
  // utility link is its navigation owner: it must open the workspace pane on
  // that same active work, through the real route, provider and API.
  await gotoWithStrictCsp(page, "/");
  await page.getByRole("link", { name: "Imports", exact: true }).click();
  await expect(page).toHaveURL(/\/imports(?:[?#]|$)/);
  await expect(
    page.getByRole("tab", { name: /^In progress/ }),
    "An entry with active work and nothing needing attention must land on In progress.",
  ).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
  const boundedRow = page.locator(`[data-import-ref="${bounded.ref}"]`);
  await expect(
    boundedRow,
    `The Imports pane did not list the independently observed active import ${bounded.media_id}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => (await boundedRow.innerText()).replace(/\s+/g, " "),
      {
        message: `The Imports pane did not project counted 712-page progress for ${bounded.media_id}.`,
        timeout: 60_000,
      },
    )
    .toMatch(/Extracting page \d+ of 712/);
  await captureImportsReview(page, testInfo, "in-progress-counted");

  // A real recovery, end to end: an upload session whose transport failed is an
  // obligation the reader can see and discharge from this pane, and the retry
  // it offers is the real client upload, not a re-request of the same command.
  const recovered = uniqueCanonicalReaderEpub(`${journeyUser.id}-imports-recovery`);
  const recoveredFilename = "imports-recovery-canonical-reader.epub";
  const strandedSession = (await readBody(
    await api.post("/api/media/uploads", {
      headers: {
        origin: webOrigin,
        "Idempotency-Key": `imports-recovery-${journeyUser.id}`,
      },
      data: {
        kind: "Epub",
        filename: recoveredFilename,
        content_type: "application/epub+zip",
        size_bytes: recovered.byteLength,
        library_ids: [],
      },
    }),
  )) as { data: { session_handle: string; generation: number } };
  const recoveredRef = `upload:${strandedSession.data.session_handle}`;
  const transportFailure = await api.post(
    `/api/media/uploads/${encodeURIComponent(strandedSession.data.session_handle)}/transport-failure`,
    {
      headers: { origin: webOrigin },
      data: {
        kind: "Network",
        generation: strandedSession.data.generation,
        duration_ms: 1_200,
        request_id: randomUUID(),
      },
    },
  );
  expect(
    transportFailure.status(),
    `Recording the upload transport failure for ${recoveredRef} was refused.`,
  ).toBe(204);

  await expect(
    page.getByRole("link", { name: "Imports, 1 needs attention", exact: true }),
    `The rail's Imports badge never carried the exact attention count for ${recoveredRef}.`,
  ).toBeVisible({ timeout: 60_000 });
  await captureImportsReview(page, testInfo, "rail-badge");
  // The collapsed rail is icon-only, and the attention count still has to paint.
  // The rail animates its width, so a capture taken on the click reviews the
  // transition rather than the icon-only rail: wait for the collapsed width
  // token (`--navbar-collapsed-width`, globals.css) to land.
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect
    .poll(
      async () =>
        (
          await page
            .getByRole("navigation", { name: "Primary" })
            .boundingBox()
        )?.width,
      {
        message: "The rail never settled at its collapsed width.",
        timeout: 15_000,
      },
    )
    .toBe(48);
  // The collapsed rail is 48 px of room shared by the icon and the count, and
  // the whole point of the count is that it can be read: the two painted boxes
  // must not intersect. Neither carries a role — the chip is the surface the
  // badge paints its digits on, the glyph is the link's icon — so the claim is
  // made on their boxes.
  const collapsedImports = page.getByRole("link", {
    name: "Imports, 1 needs attention",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        collapsedImports.evaluate((link) => {
          const glyph = link.querySelector("svg");
          const chip = link.querySelector('span[aria-hidden="true"]');
          if (glyph === null || chip === null) {
            return "the collapsed link painted no icon or no count chip at all";
          }
          const icon = glyph.getBoundingClientRect();
          const count = chip.getBoundingClientRect();
          const say = (name: string, box: DOMRect) =>
            `${name} ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(
              box.width,
            )}x${Math.round(box.height)}`;
          const intersects =
            count.left < icon.right &&
            icon.left < count.right &&
            count.top < icon.bottom &&
            icon.top < count.bottom;
          return intersects
            ? `${say("chip", count)} vs ${say("icon", icon)}`
            : "clear of the icon";
        }),
      {
        message:
          "The collapsed rail painted its attention count over the icon it belongs to, so no digit can be read.",
        timeout: 15_000,
      },
    )
    .toBe("clear of the icon");
  await captureImportsReview(page, testInfo, "rail-badge-collapsed");
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await page.getByRole("tab", { name: /^Needs attention/ }).click();
  const recoveredRow = page.locator(`[data-import-ref="${recoveredRef}"]`);
  await expect(
    recoveredRow,
    `Needs attention did not list the stranded upload ${recoveredRef}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    recoveredRow.getByText("Upload failed", { exact: true }),
    `The stranded upload ${recoveredRef} did not read as a failed upload.`,
  ).toBeVisible();
  await recoveredRow.getByRole("button", { name: recoveredFilename, exact: true }).click();
  await expect(
    page.getByTestId("workspace-secondary-pane"),
    `Selecting ${recoveredRef} did not open its inspector.`,
  ).toBeVisible();
  // The detail is a read of its own, and its skeleton is what a capture taken on
  // the selection photographs. This is the one state the review exists for — the
  // recovery offer, its scope sentence and its commands — so the capture waits
  // for that content, never for a delay.
  const inspector = page.getByRole("complementary", { name: "Import details" });
  await expect(
    inspector.getByRole("heading", { name: "Recovery", exact: true }),
    `The inspector for ${recoveredRef} had not read its detail when the review capture was taken.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    inspector.getByRole("button", { name: "Retry upload", exact: true }),
    `The inspector for ${recoveredRef} offered no recovery command to review.`,
  ).toBeVisible();
  await captureImportsReview(page, testInfo, "needs-attention-selected");

  const chooser = page.waitForEvent("filechooser");
  await recoveredRow
    .getByRole("button", { name: "Retry upload", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: recoveredFilename,
    mimeType: "application/epub+zip",
    buffer: recovered,
  });
  await expect
    .poll(
      async () => (await importDetail(api, recoveredRef)).media_ref.kind,
      {
        message: `Retrying ${recoveredRef} from the pane never published its media.`,
        timeout: 90_000,
      },
    )
    .toBe("Present");
  await expect
    .poll(
      async () => (await importDetail(api, recoveredRef)).state.kind,
      {
        message: `The recovered import ${recoveredRef} never finished its source and index work.`,
        timeout: 180_000,
      },
    )
    .toBe("Complete");

  await page.getByRole("tab", { name: /^History/ }).click();
  // A matched event is reported only when it is not the import's newest one: the
  // row's current outcome already states that event, so annotating a row with it
  // would explain nothing. Under History's own materialised 30-day window every
  // event of an import published minutes ago satisfies the query, so the newest
  // match is the newest event and no evidence line is offered. Asking the
  // question this recovery answers — which imports failed — makes the newest
  // `Failed` event strictly older than the outcome beside it, which is the
  // evidence this journey exists to read. The filter is applied through the
  // pane's own control, not by navigating to a URL, and that control is
  // addressed by its accessible identity rather than by its visible text: once
  // the filter applies, the applied-filter chip repeats that text and a text
  // query resolves to two nodes. It is a switch a reader can reach and operate
  // from the keyboard, which is how this step drives it.
  const hadFailures = page.getByRole("checkbox", {
    name: "Had failures",
    exact: true,
  });
  await hadFailures.press("Space");
  await expect(
    hadFailures,
    "The pane's own History failures filter did not apply.",
  ).toBeChecked();
  await expect(
    recoveredRow,
    `History did not retain the recovered import ${recoveredRef}.`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    recoveredRow.getByText(/^Matched: Upload failed · /),
    `History listed ${recoveredRef} without the failure that matched it.`,
  ).toBeVisible();
  await recoveredRow.getByRole("button", { name: recoveredFilename, exact: true }).click();
  await expect(
    inspector.getByRole("heading", { name: "Recovery", exact: true }),
    `The inspector for ${recoveredRef} had not read its detail when the review capture was taken.`,
  ).toBeVisible({ timeout: 60_000 });
  await captureImportsReview(page, testInfo, "history-recovered");
  expect(
    (await importsIn(api, "NeedsAttention")).map((item) => item.ref),
    `The recovered import ${recoveredRef} still needs attention after a successful recovery.`,
  ).not.toContain(recoveredRef);

  // The failures filter answered its question. The layout review below is of the
  // view a reader lands on — the whole recorded window, and the list whose long
  // titles the review exists to read — so it is removed through the pane's own
  // chip before the widths change.
  await page
    .getByRole("button", { name: "Remove filter: Had failures", exact: true })
    .click();
  await expect(
    boundedRow,
    "History did not come back to its default window when the failures filter was removed.",
  ).toBeVisible({ timeout: 60_000 });
  // The review reads how a long title truncates and how the inspector shares a
  // narrow layout with it, so the inspector it captures is opened on the longest
  // title in the list.
  await boundedRow
    .getByRole("button", { name: boundedTitle, exact: true })
    .click();
  await expect(
    inspector.getByRole("heading", { name: boundedTitle, exact: true }),
    `The inspector for ${bounded.ref} had not read its detail when the review capture was taken.`,
  ).toBeVisible({ timeout: 60_000 });

  // The layout review is of the pane, so the inspector has to be dismissed for
  // the captures that read the primary column: it is a companion here and a
  // sheet under the mobile breakpoint, and either one is a modal over the
  // surface those captures exist to read.
  const dismissInspector = async (region: Locator) => {
    await region.getByRole("button", { name: "Close Import details" }).click();
    await expect(
      region,
      "The Imports inspector stayed over the pane the layout review is of.",
    ).toBeHidden();
  };
  await dismissInspector(inspector);

  // The layout review, captured last because nothing after this step drives the
  // page. Browser zoom divides the layout viewport rather than magnifying the
  // painted output, and the layout viewport is what the media and container
  // queries answer to, so 200% of this window is a 640 px layout. Every width
  // change re-reads the list, so each capture waits for the rows rather than
  // photographing the skeletons that replace them.
  const settledAt = async (width: number) => {
    await page.setViewportSize({ width, height: 720 });
    await expect(
      boundedRow,
      `The ${width} px layout review never got the History list back.`,
    ).toBeVisible({ timeout: 60_000 });
  };
  await settledAt(1280);
  await captureImportsReview(page, testInfo, "viewport-1280x720");
  // A narrow window alone is not a touch device: the pane sizes its targets on
  // `pointer: coarse`, so a review taken with this desktop mouse attached would
  // photograph the compact desktop control sizes and deny a requirement the
  // browser proof already holds. Chromium only moves the `pointer` feature when
  // touch input is emulated, so every narrow capture below is taken with it on.
  const input = await page.context().newCDPSession(page);
  await input.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  // The coarse-pointer sizes arrive with the next style resolution, so each
  // capture waits for the toolbar to be painting them rather than racing it.
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  const coarseToolbar = async () => {
    await expect
      .poll(async () => (await refresh.boundingBox())?.height ?? 0, {
        message: "The narrow review never got the coarse-pointer touch targets.",
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(44);
  };
  // Dismissing keeps the selection in the URL by design, so crossing into the
  // mobile chrome remounts the pane and it opens the sheet for that import
  // again — which is the inspector this first narrow capture is of.
  await settledAt(640);
  const sheet = page.getByTestId("mobile-secondary-host");
  await expect(
    sheet.getByRole("heading", { name: boundedTitle, exact: true }),
    "The 640 px review never got a rendered inspector over its list.",
  ).toBeVisible({ timeout: 60_000 });
  await captureImportsReview(page, testInfo, "zoom-200-640-inspector");
  await dismissInspector(sheet);
  await expect(
    boundedRow,
    "The 640 px review lost the History list when the sheet was dismissed.",
  ).toBeVisible();
  await coarseToolbar();
  await captureImportsReview(page, testInfo, "zoom-200-640-primary");
  // The mobile chrome floats the switchboard control over the bottom of the
  // window, in the same column the rows put `More actions` in. The pane owes the
  // reader a rest position clear of it: its terminal padding must reach at least
  // as high as the control's top edge, which is what lets the last row be
  // scrolled out from under it. Geometry, not pixels — the captures beside this
  // record one scroll position and cannot answer it.
  const bottomBand = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="pane-shell-body"]');
    const control = document.querySelector('[data-testid="nexus-wrapper"]');
    if (!(body instanceof HTMLElement) || !(control instanceof HTMLElement)) {
      throw new Error(
        "The 640 px layout published no pane body or no switchboard control to measure.",
      );
    }
    return {
      restBottom:
        body.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(body).paddingBottom),
      controlTop: control.getBoundingClientRect().top,
    };
  });
  // 640 px is still above `PaneToolbar`'s ≤479 px container query, so the
  // wrapped toolbar the rubric names is only reviewable at a narrower layout:
  // 200% of an 860 px window. 430 px is the same chrome as 640 px, so it
  // inherits the dismissed sheet without another remount.
  await settledAt(430);
  await coarseToolbar();
  await captureImportsReview(page, testInfo, "zoom-200-430-toolbar-wrap");
  await input.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  // Asserted after the captures rather than where it was measured: the artifacts
  // above are this step's whole product, and a failure here must not take them.
  expect(
    bottomBand.restBottom,
    "The Imports pane reserves less than the band the floating switchboard control covers, so a trailing row's More actions can never be scrolled clear of it.",
  ).toBeLessThanOrEqual(bottomBand.controlTop);

  const rejected = await acceptPdfUpload(
    api,
    objects,
    adversarialTruncatedPdf(),
    "truncated-parser-boundary.pdf",
    `truncated-pdf-${journeyUser.id}`,
  );
  // Heavy capacity is one attempt globally, so this second bounded 712-page
  // source — accepted immediately before the interactive run, behind the
  // adversarial one — is queued or extracting for the whole round trip. Its
  // state is read again once the chat completes, which is the conjunction this
  // journey exists to prove: a Light run finishing while Heavy work is unfinished.
  const heldBack = await acceptPdfUpload(
    api,
    objects,
    boundedCitationPdf(),
    "bounded-media-processing-evidence-corpus-held-back.pdf",
    `bounded-pdf-held-back-${journeyUser.id}`,
  );
  const conversationResponse = await api.post("/api/conversations", {
    headers: { origin: webOrigin },
    data: {
      initial_context_refs: [`media:${chatEvidenceMediaId}`],
    },
  });
  const conversation = (await readBody(conversationResponse)) as {
    data: { id: string };
  };
  const catalogResponse = await api.get("/api/llm-catalog");
  const catalog = (await readBody(catalogResponse)) as {
    data: {
      definition_revision: string;
      chat_seed: { selection: unknown };
    };
  };
  const chatResponse = await api.post("/api/chat-runs", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `bounded-interactive-${randomUUID()}`,
      [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION,
    },
    data: {
      destination: {
        kind: "Existing",
        conversation_id: conversation.data.id,
        insertion: { kind: "Empty" },
      },
      content:
        "What did SOFIA establish about water in Clavius Crater? Use the attached source.",
      catalog_definition_revision: catalog.data.definition_revision,
      selection: catalog.data.chat_seed.selection,
      tool_authority: "ReadOnly",
      reader_selection: { kind: "Absent" },
    },
  });
  const admittedChat = (await readBody(chatResponse)) as {
    data: { run: { id: string; status: string } };
  };
  expect(
    admittedChat.data.run.status,
    `Interactive chat ${admittedChat.data.run.id} was not durably queued during Heavy source ${bounded.media_id}.`,
  ).toBe("queued");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/chat-runs/${admittedChat.data.run.id}`, {
          headers: { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
        });
        if (!response.ok()) return `http-${response.status()}`;
        const payload = (await response.json()) as {
          data: {
            run: { status: string };
            assistant_message: {
              status: string;
              message_document: {
                blocks: Array<{ type: string; text?: string }>;
              };
            };
          };
        };
        if (
          payload.data.run.status !== "complete" ||
          payload.data.assistant_message.status !== "complete"
        ) {
          return payload.data.run.status;
        }
        return payload.data.assistant_message.message_document.blocks.some(
          (block) => block.type === "text" && block.text?.includes("Clavius Crater"),
        );
      },
      {
        message: `Interactive worker did not complete chat ${admittedChat.data.run.id} during Heavy source ${bounded.media_id}.`,
        timeout: 90_000,
      },
    )
    .toBe(true);

  const duringLightCompletion = await importDetail(api, heldBack.ref);
  expect(
    duringLightCompletion.state.kind,
    `Heavy work ${heldBack.media_id} settled before the Light-worker outcome was observed: ${JSON.stringify(duringLightCompletion.state)}.`,
  ).toBe("Active");

  await expect
    .poll(
      async () => {
        const item = await importDetail(api, bounded.ref);
        return item.state.kind === "Complete"
          ? "complete"
          : JSON.stringify(item.state);
      },
      {
        message: `Bounded source ${bounded.media_id} did not complete its Heavy content-index operation.`,
        timeout: 120_000,
      },
    )
    .toBe("complete");
  expect(
    (await importsIn(api, "InProgress")).map((item) => item.ref),
    `Bounded source ${bounded.media_id} stayed in progress after completing.`,
  ).not.toContain(bounded.ref);
  await expect
    .poll(
      async () => {
        const item = await importDetail(api, rejected.ref);
        return item.state.kind === "NeedsAttention" &&
          item.state.failure_code.kind === "Present"
          ? item.state.failure_code.value
          : JSON.stringify(item.state);
      },
      {
        message: `Adversarial source ${rejected.media_id} did not publish its exact typed parser rejection.`,
        timeout: 90_000,
      },
    )
    .toBe("E_INVALID_FILE_TYPE");
});
