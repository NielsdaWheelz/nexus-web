import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { bootstrapMagicLinkSessionForEmail } from "./auth-bootstrap";
import {
  createPdfHighlightThroughVisibleSelection,
  gotoRealMediaSinglePane,
  readRealMediaSeed,
} from "./real-media/real-media-seed";

interface ShareUser {
  userHandle: string;
  email: string | null;
}

interface ShareRow {
  kind: "User" | "Link";
  handle: string;
  publicHref?: string;
  user?: ShareUser;
}

interface MediaFixture {
  label: string;
  mediaId: string;
  expectedKind: "web_article" | "epub" | "pdf" | "video";
  publicReader: "article" | "epub" | "pdf" | "transcript";
  needle?: string;
}

async function bootstrapUser(
  browser: Browser,
  request: APIRequestContext,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await bootstrapMagicLinkSessionForEmail(page, request, email);
  return { context, page };
}

function grantShareEntitlement(email: string): void {
  const env = { ...process.env };
  delete env.SUPABASE_AUTH_ADMIN_KEY;
  execFileSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-m",
      "nexus.ops.entitlement_overrides",
      "grant",
      "--email",
      email,
      "--plan",
      "plus",
      "--reason",
      "Universal resource sharing E2E",
      "--actor-label",
      "playwright",
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      env,
      stdio: "pipe",
    },
  );
}

async function findUser(page: Page, email: string): Promise<ShareUser> {
  const response = await page.request.get(
    `/api/users/search?q=${encodeURIComponent(email)}`,
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as { data: ShareUser[] };
  const user = payload.data.find((candidate) => candidate.email === email);
  expect(user, `No exact user-search result for ${email}`).toBeDefined();
  return user!;
}

async function createShare(
  page: Page,
  subjectRef: string,
  audience: { kind: "User"; userHandle: string } | { kind: "Link" },
): Promise<ShareRow> {
  const response = await page.request.post(
    `/api/resource-items/${encodeURIComponent(subjectRef)}/shares`,
    { data: { audience }, headers: stateChangingApiHeaders() },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { data: { share: ShareRow } }).data.share;
}

async function revokeShare(page: Page, handle: string): Promise<void> {
  const response = await page.request.delete(
    `/api/resource-shares/${encodeURIComponent(handle)}`,
    { headers: stateChangingApiHeaders() },
  );
  expect(response.status(), await response.text()).toBe(204);
}

function forgetCreated(
  created: Array<{ page: Page; handle: string }>,
  handle: string,
): void {
  const index = created.findIndex((item) => item.handle === handle);
  if (index >= 0) created.splice(index, 1);
}

async function mediaTitleAndKind(
  page: Page,
  fixture: MediaFixture,
): Promise<string> {
  const response = await page.request.get(`/api/media/${fixture.mediaId}`);
  expect(
    response.ok(),
    `${fixture.label} ${fixture.mediaId} should be readable: ${await response.text()}`,
  ).toBeTruthy();
  const payload = (await response.json()) as {
    data: {
      title: string;
      kind: string;
      processing_status: string;
    };
  };
  expect(payload.data.kind).toBe(fixture.expectedKind);
  expect(payload.data.processing_status).toBe("ready_for_reading");
  return payload.data.title;
}

async function expectPublicMediaProjection(
  page: Page,
  fixture: MediaFixture,
  title: string,
  browserErrors: string[],
): Promise<void> {
  await expect(
    page.getByText("Read-only shared view. No Nexus account is required."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();

  switch (fixture.publicReader) {
    case "article":
      await expect(page.locator("main article")).toContainText(fixture.needle!, {
        timeout: 15_000,
      });
      break;
    case "epub":
      await expect(
        page.getByRole("navigation", { name: "Book contents" }),
      ).toBeVisible();
      await expect(page.locator("main article")).toHaveText(/\S/, {
        timeout: 15_000,
      });
      break;
    case "pdf":
      await expect(
        page.locator("main .pdfViewer .page").first(),
        browserErrors.join("\n"),
      ).toBeVisible({ timeout: 30_000 });
      break;
    case "transcript":
      await expect(page.locator("main ol")).toContainText(fixture.needle!, {
        timeout: 15_000,
      });
      break;
    default:
      fixture.publicReader satisfies never;
  }
}

async function createFreshTextHighlight(
  page: Page,
  mediaId: string,
  options: {
    preferredFragmentIds?: ReadonlySet<string>;
    requireTimestamp?: boolean;
  } = {},
): Promise<{
  id: string;
  exact: string;
  fragmentIdx: number;
  tStartMs: number | null;
}> {
  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  expect(fragmentsResponse.ok(), await fragmentsResponse.text()).toBeTruthy();
  const fragments = (await fragmentsResponse.json()) as {
    data: Array<{
      id: string;
      idx: number;
      canonical_text: string;
      t_start_ms: number | null;
    }>;
  };
  const fragment = fragments.data.find((candidate) => {
    if (Array.from(candidate.canonical_text).length < 48) return false;
    if (
      options.preferredFragmentIds &&
      !options.preferredFragmentIds.has(candidate.id)
    ) {
      return false;
    }
    return !options.requireTimestamp || candidate.t_start_ms !== null;
  });
  expect(
    fragment,
    `Media ${mediaId} has no highlightable fragment`,
  ).toBeDefined();
  if (!fragment) {
    throw new Error(`Media ${mediaId} has no highlightable fragment`);
  }

  const existingResponse = await page.request.get(
    `/api/fragments/${fragment.id}/highlights`,
  );
  expect(existingResponse.ok(), await existingResponse.text()).toBeTruthy();
  const existing = (await existingResponse.json()) as {
    data: {
      highlights: Array<{
        anchor: { start_offset: number; end_offset: number };
      }>;
    };
  };
  const occupied = new Set(
    existing.data.highlights.map(
      (highlight) =>
        `${highlight.anchor.start_offset}:${highlight.anchor.end_offset}`,
    ),
  );
  const codepoints = Array.from(fragment.canonical_text);
  let selected: { startOffset: number; endOffset: number } | null = null;
  for (
    let candidate = 0;
    candidate + 40 < codepoints.length;
    candidate += 11
  ) {
    let startOffset = candidate;
    while (
      startOffset < codepoints.length &&
      /\s/.test(codepoints[startOffset])
    ) {
      startOffset += 1;
    }
    let endOffset = Math.min(startOffset + 40, codepoints.length);
    while (endOffset > startOffset && /\s/.test(codepoints[endOffset - 1])) {
      endOffset -= 1;
    }
    if (
      endOffset - startOffset >= 20 &&
      !occupied.has(`${startOffset}:${endOffset}`)
    ) {
      selected = { startOffset, endOffset };
      break;
    }
  }
  expect(
    selected,
    `Media ${mediaId} has no unused highlight range`,
  ).not.toBeNull();
  if (!selected) {
    throw new Error(`Media ${mediaId} has no unused highlight range`);
  }

  const createResponse = await page.request.post(
    `/api/fragments/${fragment.id}/highlights`,
    {
      data: {
        start_offset: selected.startOffset,
        end_offset: selected.endOffset,
        color: "green",
      },
      headers: stateChangingApiHeaders(),
    },
  );
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
  const payload = (await createResponse.json()) as {
    data: { id: string; exact: string };
  };
  expect(payload.data.exact).toBe(
    codepoints.slice(selected.startOffset, selected.endOffset).join(""),
  );
  return {
    ...payload.data,
    fragmentIdx: fragment.idx,
    tStartMs: fragment.t_start_ms,
  };
}

async function epubNonInitialSectionFragments(
  page: Page,
  mediaId: string,
): Promise<ReadonlySet<string>> {
  const response = await page.request.get(`/api/media/${mediaId}/navigation`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = (await response.json()) as {
    data: {
      sections: Array<{
        ordinal: number;
        fragment_id: string | null;
      }>;
    };
  };
  const firstOrdinal = Math.min(
    ...payload.data.sections.map((section) => section.ordinal),
  );
  const fragmentIds = new Set(
    payload.data.sections.flatMap((section) =>
      section.ordinal > firstOrdinal && section.fragment_id
        ? [section.fragment_id]
        : [],
    ),
  );
  expect(
    fragmentIds.size,
    `EPUB ${mediaId} has no non-initial section fragments`,
  ).toBeGreaterThan(0);
  return fragmentIds;
}

async function expectPublicHighlightProjection({
  anonymousPage,
  fixture,
  title,
  exact,
  publicHref,
  browserErrors,
  expectedTranscriptStartMs,
  expectedPdfPage,
}: {
  anonymousPage: Page;
  fixture: MediaFixture;
  title: string;
  exact: string;
  publicHref: string;
  browserErrors: string[];
  expectedTranscriptStartMs?: number;
  expectedPdfPage?: number;
}): Promise<void> {
  await anonymousPage.goto(publicHref);
  await expectPublicMediaProjection(
    anonymousPage,
    fixture,
    title,
    browserErrors,
  );
  await expect(
    anonymousPage.getByRole("complementary", { name: "Shared highlight" }),
  ).toContainText(exact);
  await expect(
    anonymousPage.getByText("Highlight unavailable.", { exact: true }),
    `${fixture.label} exact highlight was unavailable`,
  ).toHaveCount(0);

  const exactTarget =
    fixture.publicReader === "pdf"
      ? anonymousPage.locator(
          '[data-nexus-public-pdf-overlay="true"] [data-public-highlight-target="true"]',
        )
      : anonymousPage.locator('[data-public-highlight-target="true"]');
  await expect(exactTarget).toBeVisible({ timeout: 30_000 });
  if (fixture.publicReader !== "pdf") {
    await expect(exactTarget).toContainText(exact);
  }
  await expect(exactTarget).toBeFocused();

  if (fixture.publicReader === "epub") {
    const currentSectionIndex = await anonymousPage
      .getByRole("navigation", { name: "Book contents" })
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.findIndex(
          (button) => button.getAttribute("aria-current") === "location",
        ),
      );
    expect(
      currentSectionIndex,
      "EPUB highlight should open a non-initial section",
    ).toBeGreaterThan(0);
  }
  if (fixture.publicReader === "transcript") {
    expect(expectedTranscriptStartMs).toBeDefined();
    await expect(exactTarget).toContainText(
      formatPublicTimestamp(expectedTranscriptStartMs!),
    );
  }
  if (fixture.publicReader === "pdf") {
    expect(expectedPdfPage).toBeDefined();
    await expect(
      exactTarget.locator("xpath=ancestor::*[@data-page-number][1]"),
    ).toHaveAttribute("data-page-number", String(expectedPdfPage));
  }
}

function formatPublicTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

async function deleteHighlight(
  page: Page,
  highlightId: string,
): Promise<void> {
  const response = await page.request.delete(
    `/api/highlights/${highlightId}`,
    {
      headers: stateChangingApiHeaders(),
    },
  );
  expect([204, 404]).toContain(response.status());
}

test("@real-media resource shares remain path-local and every public reader revokes", async ({
  browser,
  page: ownerPage,
  request,
}) => {
  test.setTimeout(300_000);
  const seed = readRealMediaSeed();
  const fixtures: MediaFixture[] = [
    {
      label: "web article",
      mediaId: seed.fixtures.web.media_id,
      expectedKind: "web_article",
      publicReader: "article",
      needle: seed.fixtures.web.needle,
    },
    {
      label: "EPUB",
      mediaId: seed.fixtures.epub.media_id,
      expectedKind: "epub",
      publicReader: "epub",
    },
    {
      label: "PDF",
      mediaId: seed.fixtures.pdf.media_id,
      expectedKind: "pdf",
      publicReader: "pdf",
    },
    {
      label: "YouTube transcript",
      mediaId: seed.fixtures.video.media_id,
      expectedKind: "video",
      publicReader: "transcript",
      needle: seed.fixtures.video.needle,
    },
  ];
  const nonce = `${Date.now()}-${test.info().retry}`;
  const readerEmail = `share-reader-${nonce}@nexus.local`;
  const resharerEmail = `share-resharer-${nonce}@nexus.local`;
  const reader = await bootstrapUser(browser, request, readerEmail);
  const resharer = await bootstrapUser(browser, request, resharerEmail);
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const anonymousPage = await anonymous.newPage();
  const anonymousErrors: string[] = [];
  anonymousPage.on("console", (message) => {
    if (message.type() === "error") anonymousErrors.push(message.text());
  });
  anonymousPage.on("pageerror", (error) => {
    anonymousErrors.push(error.message);
  });
  const created: Array<{ page: Page; handle: string }> = [];
  const highlightIds: string[] = [];

  try {
    const pathLocalMedia = fixtures[0];
    const readerUser = await findUser(ownerPage, readerEmail);
    const resharerUser = await findUser(reader.page, resharerEmail);
    grantShareEntitlement(readerEmail);

    const ownerToReader = await createShare(
      ownerPage,
      `media:${pathLocalMedia.mediaId}`,
      {
        kind: "User",
        userHandle: readerUser.userHandle,
      },
    );
    created.push({ page: ownerPage, handle: ownerToReader.handle });
    expect(
      (await reader.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).ok(),
    ).toBeTruthy();

    const readerToResharer = await createShare(
      reader.page,
      `media:${pathLocalMedia.mediaId}`,
      {
        kind: "User",
        userHandle: resharerUser.userHandle,
      },
    );
    created.push({ page: reader.page, handle: readerToResharer.handle });
    expect(
      (await resharer.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).ok(),
    ).toBeTruthy();

    await revokeShare(ownerPage, ownerToReader.handle);
    forgetCreated(created, ownerToReader.handle);
    expect(
      (await reader.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).ok(),
    ).toBeTruthy();
    expect(
      (await resharer.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).ok(),
    ).toBeTruthy();

    await revokeShare(reader.page, readerToResharer.handle);
    forgetCreated(created, readerToResharer.handle);
    expect(
      (await reader.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).status(),
    ).toBe(404);
    expect(
      (await resharer.page.request.get(`/api/media/${pathLocalMedia.mediaId}`)).status(),
    ).toBe(404);

    for (const fixture of fixtures) {
      const title = await mediaTitleAndKind(ownerPage, fixture);
      const link = await createShare(ownerPage, `media:${fixture.mediaId}`, {
        kind: "Link",
      });
      created.push({ page: ownerPage, handle: link.handle });
      expect(
        link.publicHref,
        `${fixture.label} share omitted publicHref`,
      ).toBeTruthy();
      if (!link.publicHref) {
        throw new Error(`${fixture.label} share omitted publicHref`);
      }
      anonymousErrors.length = 0;
      await anonymousPage.goto(link.publicHref);
      await expectPublicMediaProjection(
        anonymousPage,
        fixture,
        title,
        anonymousErrors,
      );

      await revokeShare(ownerPage, link.handle);
      forgetCreated(created, link.handle);
      await anonymousPage.reload();
      await expect(
        anonymousPage.getByRole("heading", { name: "Share unavailable" }),
      ).toBeVisible({ timeout: 15_000 });
    }

    for (const fixture of fixtures.filter(
      (candidate) => candidate.publicReader !== "pdf",
    )) {
      const title = await mediaTitleAndKind(ownerPage, fixture);
      const preferredFragmentIds =
        fixture.publicReader === "epub"
          ? await epubNonInitialSectionFragments(ownerPage, fixture.mediaId)
          : undefined;
      const highlight = await createFreshTextHighlight(
        ownerPage,
        fixture.mediaId,
        {
          preferredFragmentIds,
          requireTimestamp: fixture.publicReader === "transcript",
        },
      );
      highlightIds.push(highlight.id);
      const highlightLink = await createShare(
        ownerPage,
        `highlight:${highlight.id}`,
        { kind: "Link" },
      );
      created.push({ page: ownerPage, handle: highlightLink.handle });
      expect(
        highlightLink.publicHref,
        `${fixture.label} highlight share omitted publicHref`,
      ).toBeTruthy();
      if (!highlightLink.publicHref) {
        throw new Error(`${fixture.label} highlight share omitted publicHref`);
      }
      anonymousErrors.length = 0;
      await expectPublicHighlightProjection({
        anonymousPage,
        fixture,
        title,
        exact: highlight.exact,
        publicHref: highlightLink.publicHref,
        browserErrors: anonymousErrors,
        expectedTranscriptStartMs:
          highlight.tStartMs === null ? undefined : highlight.tStartMs,
      });

      await revokeShare(ownerPage, highlightLink.handle);
      forgetCreated(created, highlightLink.handle);
      await anonymousPage.reload();
      await expect(
        anonymousPage.getByRole("heading", { name: "Share unavailable" }),
      ).toBeVisible({ timeout: 15_000 });
    }

    const pdfFixture = fixtures.find(
      (fixture) => fixture.publicReader === "pdf",
    );
    expect(pdfFixture, "PDF fixture is missing").toBeDefined();
    if (!pdfFixture) throw new Error("PDF fixture is missing");
    const pdfTitle = await mediaTitleAndKind(ownerPage, pdfFixture);
    await gotoRealMediaSinglePane(ownerPage, `/media/${pdfFixture.mediaId}`);
    const pdfHighlight = await createPdfHighlightThroughVisibleSelection(
      ownerPage,
      pdfFixture.mediaId,
    );
    highlightIds.push(pdfHighlight.id);
    const pdfHighlightLink = await createShare(
      ownerPage,
      `highlight:${pdfHighlight.id}`,
      { kind: "Link" },
    );
    created.push({ page: ownerPage, handle: pdfHighlightLink.handle });
    expect(
      pdfHighlightLink.publicHref,
      "PDF highlight share omitted publicHref",
    ).toBeTruthy();
    if (!pdfHighlightLink.publicHref) {
      throw new Error("PDF highlight share omitted publicHref");
    }
    anonymousErrors.length = 0;
    await expectPublicHighlightProjection({
      anonymousPage,
      fixture: pdfFixture,
      title: pdfTitle,
      exact: pdfHighlight.exact,
      publicHref: pdfHighlightLink.publicHref,
      browserErrors: anonymousErrors,
      expectedPdfPage: pdfHighlight.page_number,
    });
    await revokeShare(ownerPage, pdfHighlightLink.handle);
    forgetCreated(created, pdfHighlightLink.handle);
    await anonymousPage.reload();
    await expect(
      anonymousPage.getByRole("heading", { name: "Share unavailable" }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    for (const row of created.reverse()) {
      await revokeShare(row.page, row.handle).catch(() => undefined);
    }
    for (const highlightId of highlightIds.reverse()) {
      await deleteHighlight(ownerPage, highlightId).catch(() => undefined);
    }
    await Promise.all([
      reader.context.close(),
      resharer.context.close(),
      anonymous.close(),
    ]);
  }
});
