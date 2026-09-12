import {
  errors,
  type Page,
  type Request,
} from "playwright/test";
import { uniqueReaderMapEpub } from "../corpus";
import { uploadDocument } from "../documentUploadFixture";
import {
  expect,
  gotoWithStrictCsp,
  minioOrigin,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";

test.use({ journeyId: "reader-progress-resume" });

const READER_STATE_IDLE_SAVE_DEBOUNCE_MS = 500;
// A restored reader stays under observation for two complete owned idle-save
// windows: one for the restore publication and one for its settled follow-up.
const RESTORE_WRITE_QUIET_WINDOW_MS = READER_STATE_IDLE_SAVE_DEBOUNCE_MS * 2;

interface EpubReaderLocator {
  kind: "epub";
  target: {
    fragment_id: string;
    href_path: string;
    anchor_id: { kind: "Absent" } | { kind: "Present"; value: string };
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

interface PositionedEpubReaderSnapshot {
  state: "Positioned";
  revision: number;
  locator: EpubReaderLocator;
}

function matchesReaderStateWrite(request: Request, mediaId: string): boolean {
  const url = new URL(request.url());
  return (
    url.origin === webOrigin &&
    request.method() === "PUT" &&
    url.pathname === `/api/media/${mediaId}/reader-state`
  );
}

async function waitForReaderStateWrite(
  page: Page,
  mediaId: string,
  timeout: number,
): Promise<Request | null> {
  try {
    return await page.waitForRequest(
      (request) => matchesReaderStateWrite(request, mediaId),
      { timeout },
    );
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      return null;
    }
    throw error;
  }
}

async function uploadCanonicalEpub(
  page: Parameters<typeof signIn>[0],
  userId: string,
): Promise<string> {
  const api = pageRequest(page, webOrigin);
  const objects = pageRequest(page, minioOrigin);
  const epub = uniqueReaderMapEpub(userId);
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
  const navigationResponse = await api.get(
    `/api/media/${mediaId}/navigation`,
  );
  const navigationText = await navigationResponse.text();
  expect(
    navigationResponse.ok(),
    `EPUB navigation for ${mediaId} failed: ${navigationResponse.status()} ${navigationText.slice(0, 500)}`,
  ).toBeTruthy();
  const sections = (
    JSON.parse(navigationText) as {
      data: {
        sections: Array<{
          section_id: string;
          label: string;
          target: { fragment_id: string; offset: number };
          extent: { kind: "Present"; value: { start: { fragment_id: string; offset: number }; end: { fragment_id: string; offset: number } } };
        }>;
      };
    }
  ).data.sections;
  const target = sections.find(
    (section) => section.label === "Second",
  );
  expect(
    target,
    `EPUB ${mediaId} did not expose the fixture-owned Second section.`,
  ).toBeDefined();

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const viewport = page.getByTestId("document-viewport");
  await expect(page.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open document map", exact: true }).click();
  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByText(/Omega proves the selected section/).first()).toBeVisible();
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "a map jump must not claim reading").toBeNull();
  await page.getByRole("button", { name: "return to reading position", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "return must not claim reading").toBeNull();
  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByText(/Omega proves the selected section/).first()).toBeVisible();
  await viewport.hover();
  await page.mouse.wheel(0, 150);

  await expect
    .poll(
      async () => {
        const response = await api.get(
          `/api/media/${mediaId}/reader-state`,
        );
        if (!response.ok()) return `http-${response.status()}`;
        const snapshot = (await response.json()) as {
          data:
            | { state: "Empty" }
            | {
                state: "Positioned";
                locator: {
                  kind: string;
                  target?: { fragment_id?: string };
                };
              };
        };
        return snapshot.data.state === "Positioned" &&
          snapshot.data.locator.kind === "epub"
          ? snapshot.data.locator.target?.fragment_id
          : null;
      },
      {
        message: `Expected reader movement for ${mediaId} to persist section ${target!.section_id}.`,
        timeout: 15_000,
      },
    )
    .toBe(target!.target.fragment_id);

  expect(target!.extent.kind, "the source section must have an exact extent").toBe("Present");
  const interiorOffset = target!.extent.value.end.offset - 2;
  expect(interiorOffset).toBeGreaterThan(target!.target.offset);

  const persistedResponse = await api.get(
    `/api/media/${mediaId}/reader-state`,
  );
  const persistedText = await persistedResponse.text();
  expect(
    persistedResponse.ok(),
    `Persisted reader snapshot for ${mediaId} failed: ${persistedResponse.status()} ${persistedText.slice(0, 500)}`,
  ).toBeTruthy();
  const persisted = (JSON.parse(persistedText) as {
    data: PositionedEpubReaderSnapshot;
  }).data;
  expect(
    persisted,
    `Reader snapshot for ${mediaId} was not the exact positioned EPUB cursor selected through Chromium.`,
  ).toMatchObject({
    state: "Positioned",
    revision: expect.any(Number),
    locator: {
      kind: "epub",
      target: { fragment_id: target!.target.fragment_id },
    },
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
  const interiorWriteResponse = await api.put(
    `/api/media/${mediaId}/reader-state`,
    {
      headers: { origin: webOrigin },
      data: {
        locator: interiorLocator,
        base_revision: persisted.revision,
      },
    },
  );
  const interiorWriteText = await interiorWriteResponse.text();
  expect(
    interiorWriteResponse.ok(),
    `Interior reader cursor for ${mediaId} failed: ${interiorWriteResponse.status()} ${interiorWriteText.slice(0, 500)}`,
  ).toBeTruthy();
  const interiorSnapshot = (JSON.parse(interiorWriteText) as {
    data: PositionedEpubReaderSnapshot;
  }).data;
  expect(
    interiorSnapshot,
    `Reader BFF did not durably install the interior cursor for ${mediaId}.`,
  ).toStrictEqual({
    state: "Positioned",
    revision: persisted.revision + 1,
    locator: interiorLocator,
  });

  let resumedDocumentCommitted = false;
  const resumedReaderStateWriteRequests: Request[] = [];
  const resumedReaderStateWriteFingerprints: string[] = [];
  page.once("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      resumedDocumentCommitted = true;
    }
  });
  page.on("request", (request) => {
    if (resumedDocumentCommitted && matchesReaderStateWrite(request, mediaId)) {
      resumedReaderStateWriteRequests.push(request);
    }
  });
  page.on("response", (response) => {
    if (
      resumedDocumentCommitted &&
      matchesResponse(
        response,
        webOrigin,
        "PUT",
        `/api/media/${mediaId}/reader-state`,
      )
    ) {
      resumedReaderStateWriteFingerprints.push(
        `PUT ${new URL(response.url()).pathname} -> ${response.status()}`,
      );
    }
  });
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(viewport).toBeVisible();

  const awaitedRestoreWrite = await waitForReaderStateWrite(
    page,
    mediaId,
    RESTORE_WRITE_QUIET_WINDOW_MS,
  );
  const unexpectedRestoreWrite =
    resumedReaderStateWriteRequests[0] ?? awaitedRestoreWrite;
  expect(
    unexpectedRestoreWrite,
    `Programmatic restore for ${mediaId} echoed a reader-state write within the ${RESTORE_WRITE_QUIET_WINDOW_MS}ms detection window: ${resumedReaderStateWriteFingerprints.join(", ")}.`,
  ).toBeNull();

  const genuineWriteRequestPromise = page.waitForRequest((request) => matchesReaderStateWrite(request, mediaId));
  await viewport.hover();
  await page.mouse.wheel(0, -160);
  const genuineWriteRequest = await genuineWriteRequestPromise;
  const genuineWrite = await genuineWriteRequest.response();
  expect(
    genuineWrite,
    `Genuine reader scrolling for ${mediaId} did not receive a BFF response.`,
  ).not.toBeNull();
  const genuineWriteText = await genuineWrite!.text();
  expect(
    genuineWrite!.ok(),
    `Genuine reader scrolling for ${mediaId} failed to persist: ${genuineWrite!.status()} ${genuineWriteText}`,
  ).toBeTruthy();

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

  const closing = sections.find((section) => section.label === "Closing");
  expect(closing, "the authored source must expose its final Closing chapter").toBeDefined();
  const closingFragmentResponse = await api.get(`/api/media/${mediaId}/fragments/${closing!.target.fragment_id}`);
  expect(closingFragmentResponse.ok()).toBeTruthy();
  const closingFragment = (await closingFragmentResponse.json()) as { data: { canonical_text: string } };
  const finalOffset = Array.from(closingFragment.data.canonical_text).length;
  await page.getByRole("button", { name: "Open document map", exact: true }).click();
  await page.getByRole("button", { name: "Closing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Closing", exact: true })).toBeVisible();
  const firstEndWrite = page.waitForResponse((response) => matchesResponse(response, webOrigin, "PUT", `/api/media/${mediaId}/reader-state`));
  await viewport.press("End");
  const firstEndResponse = await firstEndWrite;
  expect(firstEndResponse.ok()).toBeTruthy();
  expect(await firstEndResponse.json()).toMatchObject({
    data: { state: "Positioned", locator: { target: { fragment_id: closing!.target.fragment_id }, locations: { text_offset: finalOffset } } },
  });
  const currentEnd = page.getByRole("button", { name: "Current position, 100% through document", exact: true });
  await expect(currentEnd, "a genuine source end must remain the current document locus").toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(currentEnd, "passive reflow replaced the exact end locus with visible-start").toBeVisible();
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "passive EOF reflow must not save reading").toBeNull();
  const awayWrite = page.waitForResponse((response) => matchesResponse(response, webOrigin, "PUT", `/api/media/${mediaId}/reader-state`));
  await viewport.press("PageUp");
  expect((await awayWrite).ok()).toBeTruthy();
  await expect(currentEnd).toHaveCount(0);
  const secondEndWrite = page.waitForResponse((response) => matchesResponse(response, webOrigin, "PUT", `/api/media/${mediaId}/reader-state`));
  await viewport.press("End");
  const secondEndResponse = await secondEndWrite;
  expect(secondEndResponse.ok()).toBeTruthy();
  expect(await secondEndResponse.json()).toMatchObject({
    data: { state: "Positioned", locator: { locations: { text_offset: finalOffset } } },
  });
  await expect(currentEnd).toBeVisible();

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
    .poll(async () => {
      const response = await api.get(`/api/media/${mediaId}/reader-state`);
      if (!response.ok()) return `http-${response.status()}`;
      return ((await response.json()) as { data: { state: string } }).data.state;
    })
    .toBe("Empty");

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  await expect(page.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
});
