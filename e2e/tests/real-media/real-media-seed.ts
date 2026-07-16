import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { openAddContentPanel } from "../add-content";
import { stateChangingApiHeaders } from "../api";
import { openEvidencePane } from "../reader";
import { selectFreshVisibleTextSnippet } from "../selection";
import { runE2eWorkerOnce, startE2eWorkerUntilMediaReady } from "../worker";
import {
  ACTIVE_WORKSPACE_PANE_SELECTOR,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
} from "../workspace";

// The real-media storage content-kinds these helpers seed and search for.
const REAL_MEDIA_CONTENT_KINDS = [
  "epub",
  "pdf",
  "podcast_episode",
  "video",
  "web_article",
] as const;

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const REAL_MEDIA_FIXTURE_DIR = path.join(
  ROOT_DIR,
  "python/tests/fixtures/real_media",
);
const REAL_MEDIA_WORKER_DRAIN_TIMEOUT_MS = 120_000;
const REAL_MEDIA_WORKER_POLL_MS = 200;
const NON_LOCAL_STORAGE_OPT_IN = "REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE";

export const FRESH_REAL_MEDIA_FIXTURES = {
  pdfSvms: {
    sizeBytes: 1_502_380,
    query: "support vectors",
    needle: "support vectors",
  },
  epubMobyDickOld: {
    sizeBytes: 840_468,
    query: "Call me Ishmael",
    needle: "Call me Ishmael",
  },
} as const;

export type RealMediaContentKind = (typeof REAL_MEDIA_CONTENT_KINDS)[number];

const REAL_MEDIA_WORKSPACE_DEVICE_ID = "real-media-e2e";
let realMediaWorkspaceSequence = 0;
const VISIBLE_WORKSPACE_PANE_SELECTOR = '[data-pane-id][data-minimized="false"]';

export interface RealMediaSearchResult {
  type: string;
  snippet: string;
  source: { media_id: string };
  activation: {
    href: string;
    kind: string;
    unresolved_reason: string | null;
  };
  context_ref: {
    type: string;
    id: string;
    evidence_span_ids: string[];
  };
  evidence_span_ids: string[];
  resolver?: unknown;
}

export interface RealMediaSavedHighlightTrace {
  id: string;
  fragment_id?: string;
  page_number?: number;
  exact: string;
  selected_text: string;
  container_selector: string;
  action_selector: string;
  request_url: string;
}

export interface RealMediaWorkerResult {
  status?: string;
  error_code?: string | null;
  retrieval_status?: string;
  processing_status?: string;
  worker_iterations?: number;
  last?: unknown;
  index_status?: string | null;
  chunk_count?: number;
  evidence_count?: number;
  embedding_count?: number;
  stdout: string;
  stderr: string;
}

interface RealMediaSearchResponseBody {
  results: RealMediaSearchResult[];
  api_url: string;
}

interface RealMediaUploadIngestResponse {
  data: {
    media_id: string;
    duplicate: boolean;
    processing_status: string;
    ingest_enqueued: boolean;
  };
}

export interface RealMediaFreshUploadTrace {
  media_id: string;
  ingest: RealMediaUploadIngestResponse["data"];
  worker: RealMediaWorkerResult;
}

export function readRealMediaSeed() {
  assertRealMediaStorageIsLocal();
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", "..", ".seed", "real-media.json"),
      "utf-8",
    ),
  );
}

export async function uploadFreshRealMediaFileThroughUi({
  page,
  artifactPath,
  filename,
  mimeType,
  expectedSizeBytes,
  seededMediaId,
  artifactSalt,
}: {
  page: Page;
  artifactPath: string;
  filename: string;
  mimeType: string;
  expectedSizeBytes: number;
  seededMediaId: string;
  artifactSalt?: string;
}): Promise<RealMediaFreshUploadTrace> {
  assertRealMediaStorageIsLocal();
  const fixtureBytes = readFileSync(artifactPath);
  expect(fixtureBytes.byteLength).toBe(expectedSizeBytes);
  const uploadSalt = artifactSalt
    ? `${artifactSalt}:${process.pid}:${Date.now()}:${randomUUID()}`
    : null;
  const uploadBytes = uploadSalt
    ? Buffer.concat([
        fixtureBytes,
        Buffer.from(`\n% nexus-real-media-e2e:${uploadSalt}\n`, "utf-8"),
      ])
    : fixtureBytes;

  await gotoRealMediaSinglePane(page, "/libraries");
  const addContentPanel = await openAddContentPanel(page, "file");

  const [ingestResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/media\/[^/]+\/ingest$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    ),
    addContentPanel.getByLabel("Upload file").setInputFiles({
      name: filename,
      mimeType,
      buffer: uploadBytes,
    }),
  ]);
  const ingestText = await ingestResponse.text();
  expect(
    ingestResponse.ok(),
    `fresh upload ingest failed with ${ingestResponse.status()} ${ingestResponse.statusText()}: ${ingestText}`,
  ).toBeTruthy();

  const ingest = JSON.parse(ingestText) as RealMediaUploadIngestResponse;
  expect(ingest.data.duplicate).toBe(false);
  expect(ingest.data.ingest_enqueued).toBe(true);
  expect(ingest.data.media_id).not.toBe(seededMediaId);
  await expectCurrentMediaUrl(page, ingest.data.media_id, 30_000);

  const worker = await drainRealMediaWorkerForMediaReady(
    page,
    ingest.data.media_id,
  );
  expect(worker.status, JSON.stringify(worker, null, 2)).toBe("success");
  expect(worker.worker_iterations ?? 0).toBeGreaterThan(0);

  return {
    media_id: ingest.data.media_id,
    ingest: ingest.data,
    worker,
  };
}

export function expectRealMediaEvidenceNeedle(
  payload: unknown,
  needle: string,
  label: string,
) {
  expect(
    (JSON.stringify(payload) ?? "").replace(/<[^>]+>/g, "").toLowerCase(),
    label,
  ).toContain(needle.toLowerCase());
}

export function writeRealMediaTrace(
  testInfo: TestInfo,
  name: string,
  payload: unknown,
) {
  const outputPath = testInfo.outputPath(name);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function runRealMediaWorkerOnce(mediaId?: string): RealMediaWorkerResult {
  assertRealMediaStorageIsLocal();

  const result = runE2eWorkerOnce({
    mediaId,
    allowedNexusEnvs: ["local"],
    extraEnv: {
      REAL_MEDIA_PROVIDER_FIXTURES: "1",
      REAL_MEDIA_FIXTURE_DIR:
        process.env.REAL_MEDIA_FIXTURE_DIR ?? REAL_MEDIA_FIXTURE_DIR,
    },
  });
  return {
    worker_iterations: result.processed ? 1 : 0,
    processing_status: result.index?.processing_status ?? undefined,
    index_status: result.index?.index_status ?? null,
    chunk_count: result.index?.chunk_count ?? 0,
    evidence_count: result.index?.evidence_count ?? 0,
    embedding_count: result.index?.embedding_count ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function drainRealMediaWorkerForChatRun(
  page: Page,
  runId: string,
) {
  const deadline = Date.now() + REAL_MEDIA_WORKER_DRAIN_TIMEOUT_MS;
  let workerIterations = 0;
  let last: unknown = null;
  let stdout = "";
  let stderr = "";

  // justify-polling: Playwright cannot subscribe to the Python worker queue. Each
  // 200ms pass drives one real worker iteration, then observes terminal state
  // through the public API until the 120s fixture budget expires.
  while (Date.now() < deadline) {
    const workerResult = runRealMediaWorkerOnce();
    workerIterations += workerResult.worker_iterations ?? 0;
    stdout = workerResult.stdout;
    stderr = workerResult.stderr;

    const response = await page.request.get(`/api/chat-runs/${runId}`);
    if (response.ok()) {
      const payload = (await response.json()) as {
        data: { run: { status: string; error_code: string | null } };
      };
      last = payload.data.run;
      if (
        ["complete", "error", "cancelled"].includes(payload.data.run.status)
      ) {
        return {
          status: payload.data.run.status,
          error_code: payload.data.run.error_code,
          worker_iterations: workerIterations,
          last,
          stdout,
          stderr,
        };
      }
    } else {
      last = `${response.status()} ${await response.text()}`;
    }
    await page.waitForTimeout(REAL_MEDIA_WORKER_POLL_MS);
  }

  return {
    status: "timeout",
    worker_iterations: workerIterations,
    last,
    stdout,
    stderr,
  };
}

export async function drainRealMediaWorkerForMediaReady(
  page: Page,
  mediaId: string,
) {
  assertRealMediaStorageIsLocal();

  // A single long-lived worker subprocess loops run_once() in-process until this
  // media reaches a terminal ingest state. Scoping the worker to
  // `ingest_media_source` (see startE2eWorkerUntilMediaReady) means a refresh /
  // re-ingest job is never starved behind the unrelated LLM side-effect backlog
  // (enrich_metadata / media_unit_build / synapse_scan) that prior ingests
  // leave queued, and amortizing
  // the subprocess spawn removes the per-iteration `uv run` cost that pushed the
  // wall-clock budget over the edge on a loaded box.
  const workerResult = await startE2eWorkerUntilMediaReady({
    mediaId,
    allowedNexusEnvs: ["local"],
    extraEnv: {
      REAL_MEDIA_PROVIDER_FIXTURES: "1",
      REAL_MEDIA_FIXTURE_DIR:
        process.env.REAL_MEDIA_FIXTURE_DIR ?? REAL_MEDIA_FIXTURE_DIR,
    },
    deadlineSeconds: Math.floor(REAL_MEDIA_WORKER_DRAIN_TIMEOUT_MS / 1000),
  });

  // Parity check against the public media API the product actually serves:
  // retrieval_status mirrors the content-index status the worker just wrote.
  let retrievalStatus = workerResult.index_status ?? "pending";
  const response = await page.request.get(`/api/media/${mediaId}`);
  if (response.ok()) {
    const payload = (await response.json()) as {
      data: { processing_status: string; retrieval_status?: string | null };
    };
    retrievalStatus = payload.data.retrieval_status ?? retrievalStatus;
  }

  return {
    status: workerResult.status,
    retrieval_status: retrievalStatus,
    processing_status: workerResult.processing_status ?? undefined,
    index_status: workerResult.index_status,
    chunk_count: workerResult.chunk_count,
    evidence_count: workerResult.evidence_count,
    embedding_count: workerResult.embedding_count,
    worker_iterations: workerResult.worker_iterations,
    last: {
      processing_status: workerResult.processing_status,
      retrieval_status: retrievalStatus,
      index_status: workerResult.index_status,
      chunk_count: workerResult.chunk_count,
      evidence_count: workerResult.evidence_count,
      embedding_count: workerResult.embedding_count,
    },
    stdout: workerResult.stdout,
    stderr: workerResult.stderr,
  };
}

// Storage content-kind → the public MediaFormat the search API now accepts.
const STORAGE_KIND_TO_FORMAT: Record<RealMediaContentKind, string> = {
  epub: "epub",
  pdf: "pdf",
  podcast_episode: "episode",
  video: "video",
  web_article: "article",
};

// Public MediaFormat → the applied-filter chip label rendered by the search surface
// (mirrors MEDIA_FORMAT_LABELS in apps/web/src/lib/search/kinds.ts).
const MEDIA_FORMAT_CHIP_LABELS: Record<string, string> = {
  article: "Articles",
  pdf: "PDFs",
  epub: "EPUBs",
  video: "Videos",
  episode: "Episodes",
  podcast: "Podcasts",
};

export async function searchRealMediaEvidenceThroughUi(
  page: Page,
  query: string,
  contentKind: RealMediaContentKind,
): Promise<RealMediaSearchResponseBody> {
  const format = STORAGE_KIND_TO_FORMAT[contentKind];
  const searchUrl = `/search?${new URLSearchParams({
    q: query,
    kinds: "documents",
    formats: format,
  })}`;
  const responsePromise = page.waitForResponse(
    (response) => {
      if (response.request().method() !== "GET") {
        return false;
      }
      const url = new URL(response.url());
      return (
        url.pathname === "/api/search" &&
        url.searchParams.get("q") === query &&
        url.searchParams.get("kinds") === "documents" &&
        url.searchParams.get("formats") === format
      );
    },
    { timeout: 60_000 },
  );
  await gotoRealMediaSinglePane(page, searchUrl);
  const searchPane = activeWorkspacePane(page);
  // The intent-model surface: Documents is the active kind chip (pressable button),
  // and the format renders as a removable chip in the applied-filter bar.
  await expect(
    searchPane
      .getByRole("group", { name: "Result kinds" })
      .getByRole("button", { name: "Documents", pressed: true }),
  ).toBeVisible();
  await expect(
    searchPane
      .getByRole("group", { name: "Applied filters" })
      .getByText(MEDIA_FORMAT_CHIP_LABELS[format], { exact: true }),
  ).toBeVisible();

  await expect(searchPane.getByLabel("Search content")).toHaveValue(query);
  const response = await responsePromise;
  expect(
    response.ok(),
    `visible search for ${contentKind} should succeed`,
  ).toBeTruthy();
  await expect(searchPane.getByText("Searching…")).toBeHidden({
    timeout: 15_000,
  });
  const body = (await response.json()) as { results: RealMediaSearchResult[] };
  return { ...body, api_url: response.url() };
}

export async function gotoRealMediaSinglePane(page: Page, href: string) {
  realMediaWorkspaceSequence += 1;
  await gotoSinglePaneWorkspace(
    page,
    `${REAL_MEDIA_WORKSPACE_DEVICE_ID}-${process.pid}-${realMediaWorkspaceSequence}`,
    href,
  );
}

export function realMediaEvidenceResultLink(
  page: Page,
  mediaId: string,
  evidenceSpanId?: string,
) {
  const evidenceNeedle = evidenceSpanId
    ? `#evidence-${evidenceSpanId}`
    : "#evidence-";
  return activeWorkspacePane(page)
    .locator(`a[href*="/media/${mediaId}${evidenceNeedle}"]`)
    .first();
}

export async function expectCurrentMediaEvidenceUrl(
  page: Page,
  mediaId: string,
  evidenceSpanId?: string,
) {
  await expectCurrentMediaUrl(page, mediaId);
  if (evidenceSpanId) {
    expect(new URL(page.url()).hash).toBe(`#evidence-${evidenceSpanId}`);
  }
}

export async function expectCurrentMediaUrl(
  page: Page,
  mediaId: string,
  timeout = 15_000,
) {
  await expect(page).toHaveURL(
    new RegExp(`/media/${escapeRegExp(mediaId)}(?:[?#]|$)`),
    { timeout },
  );
  await expect(activeWorkspacePane(page)).toBeVisible({ timeout });
}

export async function expectActivePaneHasNoLoadError(page: Page) {
  await expect(activeWorkspacePane(page)).not.toContainText(
    /not found|failed to load/i,
  );
}

export async function openActivePaneOptions(
  page: Page,
  expectedItem?: string | RegExp,
) {
  const trigger = activeWorkspacePane(page)
    .getByTestId("pane-shell-chrome")
    .getByRole("button", { name: "Options" })
    .first();
  const menu = page.getByRole("menu").last();
  await expect(trigger).toBeVisible({ timeout: 15_000 });

  if (!(await menu.isVisible().catch(() => false))) {
    await trigger.click();
  }
  await expect(menu).toBeVisible({ timeout: 5_000 });

  if (!expectedItem) {
    return;
  }

  const deadline = Date.now() + 15_000;
  let lastMenuItems: string[] = [];
  while (Date.now() < deadline) {
    const item = page.getByRole("menuitem", { name: expectedItem }).first();
    if (await item.isVisible().catch(() => false)) {
      return;
    }
    lastMenuItems = (await page.getByRole("menuitem").allTextContents().catch(
      () => [],
    )).map((label) => label.trim()).filter(Boolean);
    if (!(await menu.isVisible().catch(() => false))) {
      await trigger.click();
      await expect(menu).toBeVisible({ timeout: 2_000 });
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Active pane options did not publish ${String(expectedItem)}; saw ${
      lastMenuItems.length > 0 ? lastMenuItems.join(", ") : "<no menu items>"
    }`,
  );
}

function assertRealMediaStorageIsLocal() {
  if (process.env[NON_LOCAL_STORAGE_OPT_IN] === "1") {
    return;
  }
  const endpointUrl = process.env.R2_S3_API_ORIGIN;
  if (!endpointUrl) {
    throw new Error("R2_S3_API_ORIGIN is required for real-media E2E tests.");
  }
  let host = "";
  try {
    host = new URL(endpointUrl).hostname;
  } catch (error) {
    throw new Error(
      `R2_S3_API_ORIGIN is not a valid URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "minio"].includes(
      host,
    ) &&
    !host.endsWith(".localhost")
  ) {
    throw new Error(
      `Refusing real-media E2E against non-local R2/MinIO endpoint ${endpointUrl}. ` +
        `Set ${NON_LOCAL_STORAGE_OPT_IN}=1 to opt in explicitly.`,
    );
  }
}

export async function expectVisibleTextEvidenceHighlight(
  page: Page,
  evidenceSpanId?: string,
) {
  if (!evidenceSpanId) {
    await expect(
      page
        .locator(
          `${VISIBLE_WORKSPACE_PANE_SELECTOR} [data-highlight-anchor^="evidence-"]`,
        )
        .first(),
    ).toBeAttached({ timeout: 15_000 });
    await expect(
      page
        .locator(`${VISIBLE_WORKSPACE_PANE_SELECTOR} .hl-evidence`)
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    return;
  }

  const highlightId = evidenceSpanId.startsWith("evidence-")
    ? evidenceSpanId
    : `evidence-${evidenceSpanId}`;
  const escaped = cssAttributeValue(highlightId);
  await expect(
    page
      .locator(
        `${VISIBLE_WORKSPACE_PANE_SELECTOR} [data-highlight-anchor="${escaped}"]`,
      )
      .first(),
  ).toBeAttached({ timeout: 15_000 });
  await expect(
    page
      .locator(
        `${VISIBLE_WORKSPACE_PANE_SELECTOR} [data-active-highlight-ids~="${escaped}"]`,
      )
      .first(),
  ).toBeVisible({ timeout: 15_000 });
}

export async function expectVisiblePdfEvidenceHighlight(
  page: Page,
  evidenceSpanId?: string,
) {
  if (evidenceSpanId) {
    const highlightId = evidenceSpanId.startsWith("evidence-")
      ? evidenceSpanId
      : `evidence-${evidenceSpanId}`;
    await expect(
      page
        .locator(
          `${VISIBLE_WORKSPACE_PANE_SELECTOR} [data-testid^="pdf-highlight-${cssAttributeValue(highlightId)}-"]`,
        )
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    return;
  }
  await expect(
    page
      .locator(
        `${VISIBLE_WORKSPACE_PANE_SELECTOR} [data-testid^="pdf-highlight-evidence-"]`,
      )
      .first(),
  ).toBeVisible({ timeout: 15_000 });
}

export async function cleanupRealMediaHighlight(
  page: Page,
  highlightId: string,
  primaryError: unknown,
) {
  try {
    const response = await page.request.delete(
      `/api/highlights/${highlightId}`,
      {
        headers: stateChangingApiHeaders(),
        timeout: 5_000,
      },
    );
    if (response.status() !== 204 && response.status() !== 404) {
      throw new Error(
        `Highlight cleanup failed for ${highlightId}: ${response.status()} ${response.statusText()} ${await response.text()}`,
      );
    }
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `Product assertion and highlight cleanup failed for ${highlightId}`,
      );
    }
    throw cleanupError;
  }
}

export async function openTranscriptEvidenceSegment(
  page: Page,
  query: string,
  visibleHref: string,
) {
  const url = new URL(visibleHref, page.url());
  let startMsValue = url.searchParams.get("t_start_ms");
  if (startMsValue === null && url.hash.startsWith("#evidence-")) {
    const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
    const evidenceSpanId = url.hash.slice("#evidence-".length);
    if (mediaMatch && evidenceSpanId) {
      const resolverResponse = await page.request.get(
        `/api/media/${decodeURIComponent(mediaMatch[1])}/evidence/${evidenceSpanId}`,
      );
      const resolverPayload = (await resolverResponse.json()) as {
        data?: {
          resolver?: { params?: { t_start_ms?: string | number | null } };
        };
      };
      expect(
        resolverResponse.ok(),
        `Transcript evidence resolver should load for ${visibleHref}`,
      ).toBeTruthy();
      const resolvedStartMs =
        resolverPayload.data?.resolver?.params?.t_start_ms ?? null;
      startMsValue =
        typeof resolvedStartMs === "number"
          ? String(resolvedStartMs)
          : resolvedStartMs;
    }
  }
  const startMs = startMsValue === null ? Number.NaN : Number(startMsValue);
  if (!Number.isInteger(startMs) || startMs < 0) {
    throw new Error(
      `Transcript evidence link should include nonnegative integer t_start_ms: ${visibleHref}`,
    );
  }
  const totalSeconds = Math.floor(startMs / 1000);
  const timestamp = `${Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
  const activePane = activeWorkspacePane(page);
  const segment = activePane
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(timestamp)}\\b`) })
    .first();
  await expect(segment).toBeVisible({ timeout: 15_000 });
  await expect(segment).toHaveAttribute("aria-current", "true", {
    timeout: 10_000,
  });
  const renderer = activePane.getByTestId("html-renderer").first();
  await expect(renderer).toBeVisible({ timeout: 10_000 });
  await expect(renderer).toContainText(new RegExp(escapeRegExp(query), "i"), {
    timeout: 10_000,
  });
  await expect(renderer.locator(".hl-evidence").first()).toBeVisible({
    timeout: 10_000,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function activePaneSelector(selector: string): string {
  return selector.startsWith(ACTIVE_WORKSPACE_PANE_SELECTOR)
    ? selector
    : `${ACTIVE_WORKSPACE_PANE_SELECTOR} ${selector}`;
}

export async function createPdfHighlightThroughVisibleSelection(
  page: Page,
  mediaId: string,
): Promise<RealMediaSavedHighlightTrace> {
  const activePane = activeWorkspacePane(page);
  await expect(
    activePane
      .locator('[aria-label="PDF document"] .textLayer')
      .filter({ hasText: /\S/ })
      .first(),
  ).toBeVisible({ timeout: 15_000 });

  const pdfRootSelector = activePaneSelector('[aria-label="PDF document"]');
  const pageNumber = await page.evaluate((selector) => {
    const selectionRoot = document.querySelector(selector);
    const visiblePages = Array.from(
      selectionRoot?.querySelectorAll<HTMLElement>(".page[data-page-number]") ??
        [],
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element,
          visibleHeight:
            Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
        };
      })
      .filter((entry) => entry.visibleHeight > 0)
      .sort((a, b) => b.visibleHeight - a.visibleHeight);
    return Number(visiblePages[0]?.element.dataset.pageNumber ?? "1");
  }, pdfRootSelector);
  const textLayerSelector = activePaneSelector(
    `.page[data-page-number="${pageNumber}"] .textLayer`,
  );
  await expect(
    page.locator(textLayerSelector).filter({ hasText: /\S/ }),
  ).toBeVisible({
    timeout: 15_000,
  });

  const existingHighlightResponse = await page.request.get(
    `/api/media/${mediaId}/pdf-highlights?page_number=${pageNumber}&mine_only=false`,
  );
  expect(existingHighlightResponse.ok()).toBeTruthy();
  const existingHighlights = (await existingHighlightResponse.json()) as {
    data: { highlights: Array<{ exact?: string | null }> };
  };
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    textLayerSelector,
    existingHighlights.data.highlights.flatMap((highlight) =>
      highlight.exact ? [highlight.exact] : [],
    ),
    { method: "range" },
  );

  const highlightActions = page.getByRole("group", {
    name: /selection actions/i,
  });
  await expect(highlightActions).toBeVisible({ timeout: 5_000 });
  await highlightActions.getByRole("button", { name: "Highlight color" }).click();
  const greenHighlightButton = page.getByRole("button", { name: /^Green$/ }).first();
  await expect(greenHighlightButton).toBeVisible({ timeout: 5_000 });
  const createdHighlightResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/media/${mediaId}/pdf-highlights`),
  );
  await greenHighlightButton.click();
  const createdHighlightResponse = await createdHighlightResponsePromise;
  const createdHighlightBody = await createdHighlightResponse.text();
  expect(
    createdHighlightResponse.ok(),
    `PDF highlight create failed with ${createdHighlightResponse.status()} ${createdHighlightResponse.statusText()}: ${createdHighlightBody}`,
  ).toBeTruthy();
  const createdHighlight = JSON.parse(createdHighlightBody) as {
    data: {
      id: string;
      exact: string;
      anchor: { page_number: number };
    };
  };
  expect(createdHighlight.data.exact.replace(/\s+/g, " ").trim()).toBe(
    selectedText,
  );

  const highlightIdSelectorValue = createdHighlight.data.id
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  try {
    await expect(
      activePane
        .locator(`[data-testid^="pdf-highlight-${highlightIdSelectorValue}-"]`)
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    await cleanupRealMediaHighlight(page, createdHighlight.data.id, error);
    throw error;
  }

  return {
    id: createdHighlight.data.id,
    page_number: createdHighlight.data.anchor.page_number,
    exact: createdHighlight.data.exact,
    selected_text: selectedText,
    container_selector: textLayerSelector,
    action_selector:
      'button[aria-label="Green"]',
    request_url: createdHighlightResponse.url(),
  };
}

export async function createFragmentHighlightThroughVisibleSelection(
  page: Page,
  mediaId: string,
  containerSelector: string,
): Promise<RealMediaSavedHighlightTrace> {
  const paneScopedContainerSelector = activePaneSelector(containerSelector);
  const container = page
    .locator(paneScopedContainerSelector)
    .filter({ hasText: /\S/ })
    .first();
  await expect(container).toBeVisible({
    timeout: 15_000,
  });
  await container.scrollIntoViewIfNeeded();

  const fragmentsResponse = await page.request.get(
    `/api/media/${mediaId}/fragments`,
  );
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragments = (await fragmentsResponse.json()) as {
    data: Array<{ id: string; canonical_text: string }>;
  };
  const existingExacts: string[] = [];
  for (const fragment of fragments.data) {
    const response = await page.request.get(
      `/api/fragments/${fragment.id}/highlights`,
    );
    expect(response.ok()).toBeTruthy();
    const payload = (await response.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    existingExacts.push(
      ...payload.data.highlights.map((highlight) => highlight.exact),
    );
  }

  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    paneScopedContainerSelector,
    existingExacts,
    { method: "range" },
  );
  const highlightActions = page.getByRole("group", {
    name: /selection actions/i,
  });
  await expect(highlightActions).toBeVisible({ timeout: 5_000 });
  await highlightActions.getByRole("button", { name: "Highlight color" }).click();
  const [createdHighlightResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/fragments/") &&
        response.url().includes("/highlights"),
    ),
    page
      .getByRole("button", { name: /^Green$/ })
      .first()
      .click(),
  ]);
  expect(createdHighlightResponse.ok()).toBeTruthy();
  const createdHighlight = (await createdHighlightResponse.json()) as {
    data: {
      id: string;
      exact: string;
      anchor: { fragment_id: string };
    };
  };
  expect(createdHighlight.data.exact.replace(/\s+/g, " ").trim()).toBe(
    selectedText,
  );
  const highlightIdSelectorValue = createdHighlight.data.id
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

  try {
    await expect(
      page
        .locator(paneScopedContainerSelector)
        .locator(`[data-active-highlight-ids~="${highlightIdSelectorValue}"]`)
        .filter({ hasText: selectedText })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    const highlightsPane = await openEvidencePane(page);
    const row = highlightsPane
      .locator(`[data-highlight-id="${highlightIdSelectorValue}"]`)
      .first();
    try {
      await expect(row).toBeVisible({ timeout: 10_000 });
    } catch (error) {
      const debug = await page.evaluate(
        ({ activeSelector, containerSelector, highlightId, selectedText }) => {
          const activePane = document.querySelector<HTMLElement>(activeSelector);
          const container = document.querySelector(containerSelector);
          const escapedId = CSS.escape(highlightId);
          const targets = Array.from(
            container?.querySelectorAll<HTMLElement>(
              `[data-active-highlight-ids~="${escapedId}"]`,
            ) ?? [],
          );
          const viewport = activePane?.querySelector<HTMLElement>(
            '[data-testid="document-viewport"]',
          );
          const secondary = activePane?.querySelector<HTMLElement>(
            '[data-testid="workspace-secondary-pane"]',
          );
          return {
            targetCount: targets.length,
            targetText: targets.map((target) =>
              target.textContent?.slice(0, 120),
            ),
            targetRects: targets.map((target) =>
              Array.from(target.getClientRects()).map((rect) => ({
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              })),
            ),
            viewport: viewport
              ? {
                  top: viewport.getBoundingClientRect().top,
                  bottom: viewport.getBoundingClientRect().bottom,
                  scrollTop: viewport.scrollTop,
                  clientHeight: viewport.clientHeight,
                }
              : null,
            secondaryText: secondary?.textContent?.slice(0, 500) ?? null,
            selectedText,
          };
        },
        {
          activeSelector: ACTIVE_WORKSPACE_PANE_SELECTOR,
          containerSelector: paneScopedContainerSelector,
          highlightId: createdHighlight.data.id,
          selectedText,
        },
      );
      throw new Error(
        `Saved highlight ${createdHighlight.data.id} did not appear in the highlights secondary. Projection debug: ${JSON.stringify(debug)}`,
        { cause: error },
      );
    }
  } catch (error) {
    await cleanupRealMediaHighlight(page, createdHighlight.data.id, error);
    throw error;
  }

  return {
    id: createdHighlight.data.id,
    fragment_id: createdHighlight.data.anchor.fragment_id,
    exact: createdHighlight.data.exact,
    selected_text: selectedText,
    container_selector: paneScopedContainerSelector,
    action_selector:
      '[role="group"][aria-label="Selection actions"] button[aria-label^="Green"]',
    request_url: createdHighlightResponse.url(),
  };
}
