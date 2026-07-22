import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openAddContentPanel } from "./add-content";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
  workspacePaneButton,
} from "./workspace";

interface SlateTargetWire {
  ref: string;
  href: string;
  title: string;
}

interface SlateEnvelopeWire {
  data: { items: Array<{ target: SlateTargetWire }> };
}

interface LibraryEntriesWire {
  data: Array<{
    kind: "media" | "podcast";
    media?: { id: string };
  }>;
}

function readSeedJson(file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", ".seed", file), "utf-8"),
  ) as Record<string, unknown>;
}

function requiredId(seed: Record<string, unknown>, key: string): string {
  const value = seed[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`E2E seed is missing ${key}`);
  }
  return value;
}

function seededMediaIds(): string[] {
  const pdf = readSeedJson("pdf-media.json");
  const nonPdf = readSeedJson("non-pdf-media.json");
  const epub = readSeedJson("epub-media.json");
  const youtube = readSeedJson("youtube-media.json");
  const resume = readSeedJson("reader-resume-media.json");
  const documentMap = readSeedJson("reader-document-map-media.json");
  return [
    requiredId(pdf, "media_id"),
    requiredId(pdf, "password_media_id"),
    requiredId(nonPdf, "media_id"),
    requiredId(epub, "media_id"),
    requiredId(youtube, "media_id"),
    requiredId(youtube, "playback_only_media_id"),
    requiredId(resume, "web_media_id"),
    requiredId(resume, "epub_media_id"),
    requiredId(resume, "pdf_media_id"),
    requiredId(documentMap, "media_id"),
  ];
}

function uploadFixturePath(): string {
  const pdf = readSeedJson("pdf-media.json");
  const relativePath = requiredId(pdf, "upload_fixture_path");
  return path.join(__dirname, "..", relativePath);
}

function mediaIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/^\/media\/([0-9a-f-]{36})$/i);
  if (!match) {
    throw new Error(`Expected an uploaded media route, got ${url}`);
  }
  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectOk(
  response: { ok(): boolean; status(): number; statusText(): string; text(): Promise<string> },
  label: string,
): Promise<void> {
  if (response.ok()) return;
  throw new Error(
    `${label} failed: ${response.status()} ${response.statusText()} ${(await response.text()).slice(0, 500)}`,
  );
}

async function uploadPdf(
  page: Page,
  deviceId: string,
  fixturePath: string,
): Promise<string> {
  await gotoSinglePaneWorkspace(page, deviceId, "/libraries");
  const panel = await openAddContentPanel(page, "file");
  const input = panel.locator("input[type='file']");
  await expect(input).toBeAttached();
  await input.setInputFiles(fixturePath);
  await expect(page).toHaveURL(/\/media\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
  return mediaIdFromUrl(page.url());
}

async function getSlate(
  request: APIRequestContext,
  libraryId: string,
): Promise<SlateEnvelopeWire> {
  const response = await request.get(`/api/libraries/${libraryId}/slate`);
  await expectOk(response, `GET /api/libraries/${libraryId}/slate`);
  return (await response.json()) as SlateEnvelopeWire;
}

async function visibleSlateHrefs(page: Page, ariaLabel: string): Promise<string[]> {
  return activeWorkspacePane(page)
    .getByRole("list", { name: ariaLabel })
    .getByRole("link")
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter((href): href is string => href !== null),
    );
}

test("Reading Slate acceptance preserves survivors, excludes the accepted target, and reconciles on library reactivation", async ({
  page,
}, testInfo) => {
  test.slow();
  const deviceId = workspaceE2eDeviceId(testInfo, "e2e-reading-slate");
  const fixturePath = uploadFixturePath();
  const uploadedMediaIds: string[] = [];
  const edgeIds: string[] = [];
  let libraryId: string | null = null;
  let productError: unknown = null;

  try {
    uploadedMediaIds.push(await uploadPdf(page, deviceId, fixturePath));
    uploadedMediaIds.push(await uploadPdf(page, deviceId, fixturePath));
    expect(new Set(uploadedMediaIds).size).toBe(2);

    const libraryName = `Slate E2E ${Date.now()}`;
    const createLibrary = await page.request.post("/api/libraries", {
      headers: stateChangingApiHeaders(),
      data: { name: libraryName },
    });
    await expectOk(createLibrary, "Create Slate E2E library");
    libraryId = ((await createLibrary.json()) as { data: { id: string } }).data.id;

    const anchorMediaId = uploadedMediaIds[0];
    const candidateMediaIds = [...seededMediaIds(), uploadedMediaIds[1]];
    expect(new Set(candidateMediaIds).size).toBe(11);

    const addAnchor = await page.request.post(`/api/libraries/${libraryId}/media`, {
      headers: stateChangingApiHeaders(),
      data: { media_id: anchorMediaId },
    });
    await expectOk(addAnchor, "Add Slate anchor to destination library");

    for (const candidateId of candidateMediaIds) {
      const createEdge = await page.request.post("/api/resource-graph/edges", {
        headers: stateChangingApiHeaders(),
        data: {
          source_ref: `media:${anchorMediaId}`,
          target_ref: `media:${candidateId}`,
          kind: "context",
        },
      });
      await expectOk(createEdge, `Connect Slate candidate ${candidateId}`);
      edgeIds.push(((await createEdge.json()) as { data: { id: string } }).data.id);
    }

    await expect
      .poll(async () => (await getSlate(page.request, libraryId!)).data.items.length, {
        timeout: 15_000,
      })
      .toBe(10);
    const initialServerSlate = await getSlate(page.request, libraryId);
    expect(new Set(initialServerSlate.data.items.map((item) => item.target.ref)).size).toBe(
      10,
    );

    const libraryPath = `/libraries/${libraryId}`;
    await gotoWithWorkspaceSession(
      page,
      deviceId,
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-slate-library", libraryPath),
          makeWorkspacePane("pane-libraries", "/libraries"),
        ],
        { activePrimaryPaneId: "pane-slate-library" },
      ),
      libraryPath,
    );

    const slateAriaLabel = `Suggestions for ${libraryName}`;
    const slate = activeWorkspacePane(page).getByRole("region", {
      name: slateAriaLabel,
    });
    await expect(slate).toBeVisible({ timeout: 15_000 });
    await expect(slate.getByRole("button", { name: /Add .+ to Slate E2E / })).toHaveCount(
      10,
    );
    const initialHrefs = await visibleSlateHrefs(page, slateAriaLabel);
    expect(initialHrefs).toHaveLength(10);
    const acceptedHref = initialHrefs[0];
    const acceptedMediaId = mediaIdFromUrl(`http://localhost${acceptedHref}`);

    await slate.getByRole("button", { name: /Add .+ to Slate E2E / }).first().click();
    await expect(page.getByText(`Added to ${libraryName}`)).toBeVisible();
    const expectedSurvivors = initialHrefs.slice(1);
    await expect
      .poll(async () => {
        const hrefs = await visibleSlateHrefs(page, slateAriaLabel);
        return (
          hrefs.length === 10 &&
          expectedSurvivors.every((href, index) => hrefs[index] === href) &&
          !initialHrefs.includes(hrefs[9] ?? "")
        );
      }, { timeout: 15_000 })
      .toBe(true);
    const refilledHrefs = await visibleSlateHrefs(page, slateAriaLabel);
    expect(refilledHrefs.slice(0, 9)).toEqual(expectedSurvivors);

    await expect
      .poll(async () => {
        const serverSlate = await getSlate(page.request, libraryId!);
        return serverSlate.data.items.some(
          (item) => item.target.ref === `media:${acceptedMediaId}`,
        );
      })
      .toBe(false);
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/libraries/${libraryId}/entries`);
        await expectOk(response, "Read committed destination entries");
        const entries = (await response.json()) as LibraryEntriesWire;
        return entries.data.some(
          (entry) => entry.kind === "media" && entry.media?.id === acceptedMediaId,
        );
      })
      .toBe(true);

    const destinationEntries = activeWorkspacePane(page).getByRole("list", {
      name: "Library entries",
    });
    await expect(destinationEntries.locator(`a[href="${acceptedHref}"]`)).toHaveCount(0);
    const librariesTab = workspacePaneButton(page, /^Libraries\b/);
    const libraryTab = workspacePaneButton(
      page,
      new RegExp(`^${escapeRegExp(libraryName)}\\b`),
    );
    await librariesTab.click();
    await expect(librariesTab).toHaveAttribute("aria-current", "page");
    await libraryTab.click();
    await expect(libraryTab).toHaveAttribute("aria-current", "page");
    await expect(
      activeWorkspacePane(page)
        .getByRole("list", { name: "Library entries" })
        .locator(`a[href="${acceptedHref}"]`),
    ).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const edgeId of edgeIds.reverse()) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/resource-graph/edges/${edgeId}`,
          `Slate edge ${edgeId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (libraryId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/libraries/${libraryId}`,
          `Slate library ${libraryId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const mediaId of uploadedMediaIds.reverse()) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/media/${mediaId}`,
          `Slate media ${mediaId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwE2eCleanupFailures("Reading Slate acceptance", productError, cleanupErrors);
  }
});
