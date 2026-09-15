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

async function headingReadingLineDelta(page: Page, name: string): Promise<number> {
  const viewport = page.getByTestId("document-viewport");
  const heading = await page.getByRole("heading", { name, exact: true }).boundingBox();
  const frame = await viewport.boundingBox();
  expect(heading, `Missing ${name} source heading.`).not.toBeNull();
  expect(frame, "Missing reader viewport.").not.toBeNull();
  // DOM geometry measures the authored source start against the visible
  // reading line; no reader projection or scroll helper supplies the oracle.
  const padding = await viewport.evaluate((element) => getComputedStyle(element).scrollPaddingTop);
  // Desktop leaves CSS at auto and owns a 56px reading margin.
  const readingLine = padding === "auto" ? 56 : Number.parseFloat(padding);
  expect(Number.isFinite(readingLine)).toBe(true);
  return heading!.y - frame!.y - readingLine;
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
          parent_section_id: { kind: "Absent" } | { kind: "Present"; value: string };
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

  // Independently authored source: three peer headings share one fragment.
  // Publisher presentation is reversed and Second has a coincident alias.
  expect(Object.fromEntries(sections.map((section) => [
    section.label,
    [section.target.offset, section.extent.value.end.offset],
  ]))).toEqual({
    Opening: [0, 2925],
    Second: [2925, 5827],
    "Second alias": [2925, 5827],
    Closing: [5827, 8762],
  });
  expect(new Set(sections.map((section) => section.target.fragment_id)).size).toBe(1);
  expect(sections.map((section) => section.parent_section_id)).toEqual([
    { kind: "Absent" }, { kind: "Absent" }, { kind: "Absent" }, { kind: "Absent" },
  ]);
  const aliases = sections.filter((section) => section.target.offset === 2925);
  expect(aliases).toHaveLength(2);
  expect(new Set(aliases.map((section) => section.section_id)).size).toBe(2);
  // Equal-depth, equal-extent aliases use lexical section identity as the
  // documented tie-break. Publisher label order is not an ownership oracle.
  const [firstAliasId] = aliases.map((section) => section.section_id).sort();
  const expectedSecondLabel = aliases.find((section) => section.section_id === firstAliasId)!.label;

  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const viewport = page.getByTestId("document-viewport");
  const map = page.getByRole("region", { name: "Document map", exact: true });
  const outline = map.getByRole("list");
  const currentContents = () => outline.getByRole("button").evaluateAll((buttons) => buttons
    .filter((button) => button.getAttribute("aria-current") === "location")
    .map((button) => button.textContent));
  await expect(page.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open document map", exact: true }).click();
  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByText(/Omega proves the selected section/).first()).toBeVisible();
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "a map jump must not claim reading").toBeNull();
  await page.getByRole("button", { name: "return to reading position", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Opening", exact: true })).toBeVisible();
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "return must not claim reading").toBeNull();

  await expect(outline.getByRole("button")).toHaveText(["Closing", "Second alias", "Second", "Opening"]);
  await expect.poll(currentContents).toEqual(["Opening"]);
  await viewport.hover();
  await page.mouse.wheel(0, 150);
  await expect(map.getByText(/^section [1-9][0-9]*%$/)).toBeVisible();
  await expect.poll(currentContents).toEqual(["Opening"]);
  let previousGlobal = Number((await map.getByText(/^document [0-9]+%$/).innerText()).match(/[0-9]+/)![0]);
  for (const [heading, percentage] of [["Second", 33], ["Closing", 67]] as const) {
    const delta = await headingReadingLineDelta(page, heading);
    expect(delta, `${heading} must follow the actual current source viewport`).toBeGreaterThan(0);
    await viewport.hover();
    await page.mouse.wheel(0, delta);
    await expect.poll(async () => Math.abs(await headingReadingLineDelta(page, heading))).toBeLessThanOrEqual(1);
    await expect.poll(currentContents).toEqual([heading === "Second" ? expectedSecondLabel : heading]);
    await expect(map.getByText("outside this section", { exact: true })).toBeVisible();
    await expect(map.getByText(`document ${percentage}%`, { exact: true })).toBeVisible();
    expect(percentage).toBeGreaterThan(previousGlobal);
    previousGlobal = percentage;
    await map.getByRole("button", { name: "current section", exact: true }).click();
    await expect(map.getByText("section 0%", { exact: true })).toBeVisible();
  }

  await expect.poll(async () => {
    const response = await api.get(`/api/media/${mediaId}/reader-state`);
    expect(response.ok()).toBe(true);
    const snapshot = (await response.json()) as { data: { state: "Empty" } | PositionedEpubReaderSnapshot };
    return snapshot.data.state === "Positioned" ? snapshot.data.locator.locations.text_offset : null;
  }, { message: "genuine scrolling into Closing must settle before toolbar-only navigation" }).toBeGreaterThanOrEqual(5827);
  expect(await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS), "the preceding genuine scroll must finish saving before toolbar observation").toBeNull();
  const toolbarRequests: Request[] = [];
  const recordToolbarRequest = (request: Request) => toolbarRequests.push(request);
  page.on("request", recordToolbarRequest);

  // The hosted controls traverse unique source starts, independent of the
  // publisher order and whichever coincident Second alias owns current state.
  await expect(page.getByRole("button", { name: "Next section", exact: true })).toBeDisabled();
  let previousTop = await viewport.evaluate((element) => element.scrollTop);
  for (const [direction, heading] of [["Previous", "Second"], ["Previous", "Opening"], ["Next", "Second"], ["Next", "Closing"]] as const) {
    await page.getByRole("button", { name: `${direction} section`, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeInViewport();
    await expect.poll(currentContents).toEqual([heading === "Second" ? expectedSecondLabel : heading]);
    await expect.poll(async () => {
      const delta = await headingReadingLineDelta(page, heading);
      const top = await viewport.evaluate((element) => element.scrollTop);
      return Math.abs(delta) <= 1 || (top === 0 && delta < 0);
    }, { message: `${direction} must reveal ${heading} at the reading line, allowing only source-start clamping` }).toBe(true);
    await expect(page.getByRole("button", { name: "Previous section", exact: true })).toHaveJSProperty("disabled", heading === "Opening");
    const nextTop = await viewport.evaluate((element) => element.scrollTop);
    expect((nextTop - previousTop) * (direction === "Previous" ? -1 : 1), `${direction} must move to a distinct ${heading} source position`).toBeGreaterThan(0);
    previousTop = nextTop;
  }
  await expect(page.getByRole("button", { name: "Next section", exact: true })).toBeDisabled();
  const delayedToolbarWrite = await waitForReaderStateWrite(page, mediaId, RESTORE_WRITE_QUIET_WINDOW_MS);
  page.off("request", recordToolbarRequest);
  const toolbarWrite = toolbarRequests.find((request) => matchesReaderStateWrite(request, mediaId));
  expect(toolbarWrite ?? delayedToolbarWrite, "section controls must not claim reading through reader-state writes").toBeNull();
  await outline.getByRole("button", { name: "Second", exact: true }).click();
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
                  locations?: { text_offset: number | null };
                };
              };
        };
        return snapshot.data.state === "Positioned" &&
          snapshot.data.locator.kind === "epub" &&
          typeof snapshot.data.locator.locations?.text_offset === "number" &&
          snapshot.data.locator.locations.text_offset > 2925 &&
          snapshot.data.locator.locations.text_offset < 5827
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
