import {
  errors,
  type Page,
  type Request,
} from "playwright/test";
import { uniqueCanonicalReaderEpub } from "../corpus";
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
  const epub = uniqueCanonicalReaderEpub(userId);
  const initResponse = await api.post("/api/media/upload/init", {
    headers: {
      origin: webOrigin,
      "Idempotency-Key": `reader-progress-${userId}`,
    },
    data: {
      kind: "epub",
      filename: "canonical-reader-progress.epub",
      content_type: "application/epub+zip",
      size_bytes: epub.byteLength,
      library_ids: [],
    },
  });
  const initText = await initResponse.text();
  expect(
    initResponse.ok(),
    `Reader fixture acceptance failed: ${initResponse.status()} ${initText.slice(0, 500)}`,
  ).toBeTruthy();
  const init = (JSON.parse(initText) as {
    data: { media_id: string; upload_url: string | null };
  }).data;
  if (init.upload_url) {
    const upload = await objects.put(init.upload_url, {
      headers: { "Content-Type": "application/epub+zip" },
      data: epub,
    });
    expect(
      upload.ok(),
      `Local EPUB object upload for ${init.media_id} failed with ${upload.status()}.`,
    ).toBeTruthy();
    const confirm = await api.post(`/api/media/${init.media_id}/ingest`, {
      headers: { origin: webOrigin },
      data: { library_ids: [] },
    });
    expect(
      confirm.ok(),
      `EPUB confirmation for ${init.media_id} failed: ${confirm.status()} ${await confirm.text()}`,
    ).toBeTruthy();
  }
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${init.media_id}`);
        if (!response.ok()) return `http-${response.status()}`;
        return ((await response.json()) as {
          data: { processing_status: string };
        }).data.processing_status;
      },
      {
        message: `Expected EPUB ${init.media_id} to become readable before progress movement.`,
        timeout: 25_000,
      },
    )
    .toBe("ready_for_reading");
  return init.media_id;
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
          href_path: string | null;
          start_offset: number;
          end_offset: number | null;
        }>;
      };
    }
  ).data.sections.filter((section) => section.href_path !== null);
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
                  target?: { section_id?: string };
                };
              };
        };
        return snapshot.data.state === "Positioned" &&
          snapshot.data.locator.kind === "epub"
          ? snapshot.data.locator.target?.section_id
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
      target: { section_id: target!.section_id },
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

  const targetIndex = sections.findIndex(
    (section) => section.section_id === target!.section_id,
  );
  const genuineNavigationTarget = sections[targetIndex - 1];
  expect(
    genuineNavigationTarget,
    `EPUB ${mediaId} did not expose a section before ${target!.section_id} for genuine navigation.`,
  ).toBeDefined();
  const genuineWriteRequestPromise = page.waitForRequest((request) =>
    matchesReaderStateWrite(request, mediaId),
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

  await page.getByRole("button", { name: "Options", exact: true }).click();
  const completionResponsePromise = page.waitForResponse(
    (response) =>
      matchesResponse(response, webOrigin, "POST", "/api/consumption/commands"),
  );
  await page
    .getByRole("menuitem", { name: "Mark as finished", exact: true })
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

  await page.getByRole("button", { name: "Options", exact: true }).click();
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
  await expect(page.getByLabel("Select section")).not.toHaveValue(
    target!.section_id,
  );
});
