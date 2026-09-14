import {
  errors,
  type Page,
  type Request,
} from "playwright/test";
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
import { matchesResponse, pageRequest, type ExactOriginRequest } from "../request";

test.use({ journeyId: "reader-progress-resume" });

const READER_STATE_IDLE_SAVE_DEBOUNCE_MS = 500;
// A restored reader stays under observation for two complete owned idle-save
// windows: one for the restore publication and one for its settled follow-up.
const RESTORE_WRITE_QUIET_WINDOW_MS = READER_STATE_IDLE_SAVE_DEBOUNCE_MS * 2;

interface EpubReaderLocator {
  kind: "epub";
  target: {
    section_id: string;
    href_path: string;
    anchor_id: string | null;
  };
  locations: {
    text_offset: number | null;
    progression: number | null;
    total_progression: number | null;
    position: number | null;
  };
  text: {
    quote: string | null;
    quote_prefix: string | null;
    quote_suffix: string | null;
  };
}

interface PublicationCursorSource {
  kind: "Publication";
  reader_generation: number;
}

interface PositionedEpubReaderSnapshot {
  state: "Positioned";
  revision: number;
  locator: EpubReaderLocator;
  source: PublicationCursorSource;
}

interface ReaderProgressState {
  accountId: string;
  readerGeneration: number | null;
  cursor: { state: "Empty"; revision: number } | PositionedEpubReaderSnapshot;
}

interface PublicationSection {
  section_id: string;
  label: string;
  href_path: string | null;
  start_offset: number;
  end_offset: number | null;
}

interface PublicationIndexPage {
  sections: PublicationSection[];
  next_ref: { key: string } | null;
}

function progressPath(mediaId: string): string {
  return `/api/media/${mediaId}/offline-reader-state`;
}

/** The one durable progress write: account-bound, generation-fenced. */
function matchesReaderProgressWrite(request: Request, mediaId: string): boolean {
  const url = new URL(request.url());
  return (
    url.origin === webOrigin &&
    request.method() === "PUT" &&
    url.pathname === progressPath(mediaId)
  );
}

async function waitForReaderProgressWrite(
  page: Page,
  mediaId: string,
  timeout: number,
): Promise<Request | null> {
  try {
    return await page.waitForRequest(
      (request) => matchesReaderProgressWrite(request, mediaId),
      { timeout },
    );
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      return null;
    }
    throw error;
  }
}

async function readerProgress(
  api: ExactOriginRequest,
  mediaId: string,
  accountId: string,
): Promise<ReaderProgressState> {
  const response = await api.get(progressPath(mediaId), {
    headers: { "X-Nexus-Expected-Account-Id": accountId },
  });
  const text = await response.text();
  expect(
    response.ok(),
    `Reader progress for ${mediaId} failed: ${response.status()} ${text.slice(0, 500)}`,
  ).toBeTruthy();
  return (JSON.parse(text) as { data: ReaderProgressState }).data;
}

function positionedCursor(
  progress: ReaderProgressState,
  message: string,
): PositionedEpubReaderSnapshot {
  if (progress.cursor.state !== "Positioned") {
    throw new Error(`${message}: ${JSON.stringify(progress.cursor)}`);
  }
  return progress.cursor;
}

/** Every published section, following the index member chain the reader follows. */
async function publicationSections(
  api: ExactOriginRequest,
  mediaId: string,
  generation: number,
): Promise<PublicationSection[]> {
  const sections: PublicationSection[] = [];
  let after: string | null = null;
  for (;;) {
    const response = await api.get(
      `/api/media/${mediaId}/reader-publications/${generation}/index`
        + (after === null ? "" : `?after=${encodeURIComponent(after)}`),
    );
    const text = await response.text();
    expect(
      response.ok(),
      `Reader publication index for ${mediaId} failed: ${response.status()} ${text.slice(0, 500)}`,
    ).toBeTruthy();
    const indexPage = JSON.parse(text) as PublicationIndexPage;
    sections.push(...indexPage.sections);
    if (indexPage.next_ref === null) return sections;
    after = indexPage.next_ref.key;
  }
}

async function uploadCanonicalEpub(
  page: Parameters<typeof signIn>[0],
  userId: string,
): Promise<string> {
  const api = pageRequest(page, webOrigin);
  const objects = pageRequest(page, minioOrigin);
  const epub = uniqueCanonicalReaderEpub(userId);
  const published = await uploadDocument({
    api,
    objects,
    payload: epub,
    kind: "Epub",
    filename: "canonical-reader-progress.epub",
    idempotencyKey: `reader-progress-${userId}`,
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
        message: `Expected EPUB ${mediaId} to become readable before progress movement.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");
  return mediaId;
}

test("reader progress resumes, completes, and resets through its product actions", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);
  const mediaId = await uploadCanonicalEpub(page, journeyUser.id);
  const published = await readerProgress(api, mediaId, journeyUser.id);
  expect(
    published.readerGeneration,
    `EPUB ${mediaId} exposed no reader publication to take a position against.`,
  ).not.toBeNull();
  const generation = published.readerGeneration!;
  const sections = (
    await publicationSections(api, mediaId, generation)
  ).filter((section) => section.href_path !== null);
  const target = sections.find(
    (section) => section.label === "Second",
  );
  expect(
    target,
    `EPUB ${mediaId} did not expose the fixture-owned Second section.`,
  ).toBeDefined();

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const sectionPicker = page.getByLabel("Select section");
  await expect(sectionPicker).toBeVisible();
  await sectionPicker.selectOption(target!.section_id);
  await expect(
    page.getByRole("heading", { name: target!.label, exact: true }),
    `Reader did not render selected section ${target!.section_id} (${target!.label}).`,
  ).toBeVisible();
  await expect(
    page.getByText(/Omega proves the selected section/).first(),
    `Reader section ${target!.section_id} omitted the fixture-owned Second passage.`,
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        const cursor = (await readerProgress(api, mediaId, journeyUser.id)).cursor;
        return cursor.state === "Positioned"
          ? cursor.locator.target.section_id
          : null;
      },
      {
        message: `Expected reader movement for ${mediaId} to persist section ${target!.section_id}.`,
        timeout: 15_000,
      },
    )
    .toBe(target!.section_id);

  expect(
    target!.end_offset,
    `EPUB ${mediaId} did not expose a closed canonical interval for section ${target!.section_id}.`,
  ).not.toBeNull();
  const interiorOffset = target!.end_offset! - 1;
  expect(
    interiorOffset,
    `EPUB ${mediaId} section ${target!.section_id} has no interior canonical cursor between ${target!.start_offset} and ${target!.end_offset}.`,
  ).toBeGreaterThan(target!.start_offset);

  const persisted = positionedCursor(
    await readerProgress(api, mediaId, journeyUser.id),
    `Reader cursor for ${mediaId} was not positioned after Chromium selected a section`,
  );
  expect(
    persisted,
    `Reader snapshot for ${mediaId} was not the exact positioned EPUB cursor selected through Chromium.`,
  ).toMatchObject({
    state: "Positioned",
    revision: expect.any(Number),
    locator: {
      kind: "epub",
      target: { section_id: target!.section_id },
    },
    source: { kind: "Publication", reader_generation: generation },
  });
  expect(persisted.revision).toBeGreaterThan(0);
  expect(
    persisted.locator.locations.text_offset,
    `Chromium already persisted the sensitivity cursor ${interiorOffset}; the reload would not prove a distinct restored position.`,
  ).not.toBe(interiorOffset);

  const interiorLocator: EpubReaderLocator = {
    ...persisted.locator,
    locations: {
      text_offset: interiorOffset,
      progression: null,
      total_progression: null,
      position: null,
    },
    text: {
      quote: null,
      quote_prefix: null,
      quote_suffix: null,
    },
  };
  const interiorWriteResponse = await api.put(progressPath(mediaId), {
    headers: {
      origin: webOrigin,
      "X-Nexus-Expected-Account-Id": journeyUser.id,
    },
    data: {
      expectedReaderGeneration: generation,
      baseRevision: persisted.revision,
      locator: interiorLocator,
    },
  });
  const interiorWriteText = await interiorWriteResponse.text();
  expect(
    interiorWriteResponse.ok(),
    `Interior reader cursor for ${mediaId} failed: ${interiorWriteResponse.status()} ${interiorWriteText.slice(0, 500)}`,
  ).toBeTruthy();
  expect(
    interiorWriteResponse.headers()["nexus-reader-generation"],
    `Interior reader cursor for ${mediaId} was not attested against the generation it was taken from.`,
  ).toBe(String(generation));
  const interiorSnapshot = (JSON.parse(interiorWriteText) as {
    data: ReaderProgressState;
  }).data.cursor;
  expect(
    interiorSnapshot,
    `Reader BFF did not durably install the interior cursor for ${mediaId}.`,
  ).toStrictEqual({
    state: "Positioned",
    revision: persisted.revision + 1,
    locator: interiorLocator,
    source: { kind: "Publication", reader_generation: generation },
  });

  let resumedDocumentCommitted = false;
  const resumedProgressWriteRequests: Request[] = [];
  const resumedProgressWriteFingerprints: string[] = [];
  page.once("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      resumedDocumentCommitted = true;
    }
  });
  page.on("request", (request) => {
    if (resumedDocumentCommitted && matchesReaderProgressWrite(request, mediaId)) {
      resumedProgressWriteRequests.push(request);
    }
  });
  page.on("response", (response) => {
    if (
      resumedDocumentCommitted &&
      matchesResponse(response, webOrigin, "PUT", progressPath(mediaId))
    ) {
      resumedProgressWriteFingerprints.push(
        `PUT ${new URL(response.url()).pathname} -> ${response.status()}`,
      );
    }
  });
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(
    page.getByRole("heading", { name: target!.label, exact: true }),
    `Fresh reader document for ${mediaId} did not resume section ${target!.section_id}.`,
  ).toBeVisible();
  const resumedSectionPicker = page.getByLabel("Select section");
  await expect(resumedSectionPicker).toHaveValue(target!.section_id);
  await expect(
    page.getByText(/Omega proves the selected section/).first(),
    `Fresh reader document for ${mediaId} resumed the label but not the Second passage.`,
  ).toBeVisible();

  const awaitedRestoreWrite = await waitForReaderProgressWrite(
    page,
    mediaId,
    RESTORE_WRITE_QUIET_WINDOW_MS,
  );
  const unexpectedRestoreWrite =
    resumedProgressWriteRequests[0] ?? awaitedRestoreWrite;
  expect(
    unexpectedRestoreWrite,
    `Programmatic restore for ${mediaId} echoed a reader-state write within the ${RESTORE_WRITE_QUIET_WINDOW_MS}ms detection window: ${resumedProgressWriteFingerprints.join(", ")}.`,
  ).toBeNull();

  const targetIndex = sections.findIndex(
    (section) => section.section_id === target!.section_id,
  );
  const genuineNavigationTarget = sections[targetIndex - 1];
  expect(
    genuineNavigationTarget,
    `EPUB ${mediaId} did not expose a section before ${target!.section_id} for genuine navigation.`,
  ).toBeDefined();
  const genuineWriteRequestPromise = page.waitForRequest((request) =>
    matchesReaderProgressWrite(request, mediaId),
  );
  await page
    .getByRole("button", { name: "Previous section", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: genuineNavigationTarget!.label,
      exact: true,
    }),
    `Genuine reader navigation did not render ${genuineNavigationTarget!.section_id} (${genuineNavigationTarget!.label}).`,
  ).toBeVisible();
  const genuineWriteRequest = await genuineWriteRequestPromise;
  const genuineWrite = await genuineWriteRequest.response();
  expect(
    genuineWrite,
    `Genuine reader navigation for ${mediaId} did not receive a BFF response.`,
  ).not.toBeNull();
  const genuineWriteText = await genuineWrite!.text();
  expect(
    genuineWrite!.ok(),
    `Genuine reader navigation for ${mediaId} failed to persist: ${genuineWrite!.status()} ${genuineWriteText}`,
  ).toBeTruthy();
  // The product's own write must carry the fence, not just reach the endpoint.
  expect(
    genuineWriteRequest.headers()["x-nexus-expected-account-id"],
    `Genuine reader navigation for ${mediaId} wrote without binding its account.`,
  ).toBe(journeyUser.id);
  expect(
    (genuineWriteRequest.postDataJSON() as { expectedReaderGeneration: number })
      .expectedReaderGeneration,
    `Genuine reader navigation for ${mediaId} wrote against another generation.`,
  ).toBe(generation);
  expect(
    (await genuineWrite!.headerValue("nexus-reader-generation")),
    `Genuine reader navigation for ${mediaId} was not attested against its generation.`,
  ).toBe(String(generation));

  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", {
      name: "Mark as finished",
      exact: true,
    }),
  ).toBeVisible();
  const completionResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/consumption/commands"),
  );
  await page
    .getByRole("menuitemcheckbox", { name: "Mark as finished", exact: true })
    .click();
  const completionResponse = await completionResponsePromise;
  expect(
    completionResponse.ok(),
    `Completion command for ${mediaId} failed: ${completionResponse.status()} ${await completionResponse.text()}`,
  ).toBeTruthy();
  await expect
    .poll(async () => {
      const response = await api.get(`/api/media/${mediaId}`);
      if (!response.ok()) return `http-${response.status()}`;
      return ((await response.json()) as { data: { read_state: string } }).data
        .read_state;
    })
    .toBe("finished");

  await page.getByRole("button", { name: "More", exact: true }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.",
    );
    await dialog.accept();
  });
  const resetResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/consumption/commands"),
  );
  await page
    .getByRole("menuitem", { name: "Reset progress", exact: true })
    .click();
  const resetResponse = await resetResponsePromise;
  expect(
    resetResponse.ok(),
    `Reset command for ${mediaId} failed: ${resetResponse.status()} ${await resetResponse.text()}`,
  ).toBeTruthy();
  await expect
    .poll(async () => (await readerProgress(api, mediaId, journeyUser.id)).cursor.state)
    .toBe("Empty");

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(page.getByLabel("Select section")).not.toHaveValue(
    target!.section_id,
  );
});
