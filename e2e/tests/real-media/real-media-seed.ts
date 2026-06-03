import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { stateChangingApiHeaders } from "../api";
import supabaseEnv from "../../supabase-env.cjs";
import { openHighlightsPane as openReaderHighlightsPane } from "../reader";
import { selectFreshVisibleTextSnippet } from "../selection";
import {
  ACTIVE_WORKSPACE_PANE_SELECTOR,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
} from "../workspace";

const { buildE2eAppRuntimeEnv } = supabaseEnv;
const CONTENT_KIND_LABELS = {
  epub: "EPUBs",
  pdf: "PDFs",
  podcast_episode: "Episodes",
  video: "Videos",
  web_article: "Articles",
} as const;

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const REAL_MEDIA_FIXTURE_DIR = path.join(
  ROOT_DIR,
  "python/tests/fixtures/real_media",
);
const REAL_MEDIA_WORKER_DRAIN_TIMEOUT_MS = 120_000;
const REAL_MEDIA_WORKER_POLL_MS = 200;
const REAL_MEDIA_WORKER_ITERATION_TIMEOUT_MS = 30_000;
const NON_LOCAL_STORAGE_OPT_IN = "REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE";

export const FRESH_REAL_MEDIA_FIXTURES = {
  pdfSvms: {
    sha256: "4aed6fc3d300ce7552b341e3e01f3d795aa437de1045c022e6ee0b4309492531",
    query: "support vectors",
    needle: "support vectors",
  },
  epubMobyDickOld: {
    sha256: "29d4cd3f8f953cf91d030b3581c805944a063dfc216ee48628f3c87ba5ace266",
    query: "Call me Ishmael",
    needle: "Call me Ishmael",
  },
} as const;

export type RealMediaContentKind = keyof typeof CONTENT_KIND_LABELS;

const REAL_MEDIA_WORKSPACE_DEVICE_ID = "real-media-e2e";
let realMediaWorkspaceSequence = 0;
const VISIBLE_WORKSPACE_PANE_SELECTOR = '[data-pane-id][data-minimized="false"]';

export interface RealMediaSearchResult {
  type: string;
  snippet: string;
  source: { media_id: string };
  context_ref: {
    type: string;
    id: string;
    evidence_span_ids: string[];
  };
  evidence_span_ids: string[];
  deep_link: string;
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
  index_run_state?: string | null;
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
  artifact_sha256: string;
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
  expectedSha256,
  seededMediaId,
  seededSha256,
  artifactSalt,
}: {
  page: Page;
  artifactPath: string;
  filename: string;
  mimeType: string;
  expectedSha256: string;
  seededMediaId: string;
  seededSha256: string;
  artifactSalt?: string;
}): Promise<RealMediaFreshUploadTrace> {
  assertRealMediaStorageIsLocal();
  const fixtureBytes = readFileSync(artifactPath);
  expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
    expectedSha256,
  );
  const uploadSalt = artifactSalt
    ? `${artifactSalt}:${process.pid}:${Date.now()}:${randomUUID()}`
    : null;
  const uploadBytes = uploadSalt
    ? Buffer.concat([
        fixtureBytes,
        Buffer.from(`\n% nexus-real-media-e2e:${uploadSalt}\n`, "utf-8"),
      ])
    : fixtureBytes;
  const artifactSha256 = createHash("sha256").update(uploadBytes).digest("hex");
  expect(artifactSha256).not.toBe(seededSha256);

  await gotoRealMediaSinglePane(page, "/libraries");
  await page.getByRole("button", { name: "Add content" }).click();
  const addContentDialog = page.getByRole("dialog", { name: "Add content" });
  await expect(addContentDialog).toBeVisible();

  const [ingestResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/media\/[^/]+\/ingest$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    ),
    addContentDialog.getByLabel("Upload file").setInputFiles({
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
    artifact_sha256: artifactSha256,
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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to drain the real-media worker.");
  }
  const nexusEnv = process.env.NEXUS_ENV ?? "local";
  if (nexusEnv !== "local") {
    throw new Error(
      `Refusing to run real-media fixture worker with NEXUS_ENV=${nexusEnv}.`,
    );
  }
  let databaseHost = "";
  try {
    databaseHost = new URL(
      databaseUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://"),
    ).hostname;
  } catch (error) {
    throw new Error(
      `DATABASE_URL is not a valid PostgreSQL URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost)) {
    throw new Error(
      `Refusing to run real-media fixture worker against non-local database host ${databaseHost}.`,
    );
  }

  const workerEnv = {
    ...buildE2eAppRuntimeEnv(process.env),
    DATABASE_URL: databaseUrl,
    NEXUS_ENV: nexusEnv,
    REAL_MEDIA_PROVIDER_FIXTURES: "1",
    REAL_MEDIA_FIXTURE_DIR:
      process.env.REAL_MEDIA_FIXTURE_DIR ?? REAL_MEDIA_FIXTURE_DIR,
    ...(mediaId ? { NEXUS_REAL_MEDIA_READY_MEDIA_ID: mediaId } : {}),
  };

  const child = spawnSync(
    "uv",
    [
      "run",
      "--project",
      "python",
      "python",
      "-c",
      `
import json
import os

from apps.worker.main import create_worker

payload = {"processed": bool(create_worker().run_once())}
media_id = os.environ.get("NEXUS_REAL_MEDIA_READY_MEDIA_ID")
if media_id:
    import psycopg

    database_url = os.environ["DATABASE_URL"].replace(
        "postgresql+psycopg://",
        "postgresql://",
        1,
    )
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    m.processing_status::text,
                    COALESCE(mcis.status, 'pending'),
                    active_run.state,
                    count(DISTINCT cc.id),
                    count(DISTINCT es.id),
                    count(DISTINCT ce.id)
                FROM media m
                LEFT JOIN media_content_index_states mcis ON mcis.media_id = m.id
                LEFT JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                LEFT JOIN content_chunks cc
                  ON cc.media_id = m.id
                 AND cc.index_run_id = mcis.active_run_id
                LEFT JOIN evidence_spans es
                  ON es.media_id = m.id
                 AND es.index_run_id = mcis.active_run_id
                LEFT JOIN content_embeddings ce ON ce.chunk_id = cc.id
                WHERE m.id = %s::uuid
                GROUP BY m.processing_status, mcis.status, active_run.state
                """,
                (media_id,),
            )
            row = cur.fetchone()
    payload["index"] = None if row is None else {
        "processing_status": row[0],
        "index_status": row[1],
        "index_run_state": row[2],
        "chunk_count": row[3],
        "evidence_count": row[4],
        "embedding_count": row[5],
    }
print(json.dumps(payload, sort_keys=True))
`,
    ],
    {
      cwd: ROOT_DIR,
      env: workerEnv,
      encoding: "utf-8",
      timeout: REAL_MEDIA_WORKER_ITERATION_TIMEOUT_MS,
    },
  );

  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout);
  }

  const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<
    string,
    unknown
  >;
  const index = result.index as
    | {
        index_status?: string | null;
        index_run_state?: string | null;
        chunk_count?: number;
        evidence_count?: number;
        embedding_count?: number;
      }
    | null
    | undefined;
  return {
    worker_iterations: result.processed === true ? 1 : 0,
    last: result.last,
    index_status: index?.index_status ?? null,
    index_run_state: index?.index_run_state ?? null,
    chunk_count: Number(index?.chunk_count ?? 0),
    evidence_count: Number(index?.evidence_count ?? 0),
    embedding_count: Number(index?.embedding_count ?? 0),
    stdout: child.stdout.slice(-4000),
    stderr: child.stderr.slice(-4000),
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
  const deadline = Date.now() + REAL_MEDIA_WORKER_DRAIN_TIMEOUT_MS;
  let workerIterations = 0;
  let last: unknown = null;
  let stdout = "";
  let stderr = "";

  // justify-polling: media refresh completion is produced by the external worker
  // loop. Each 200ms pass drives one real worker iteration, then observes the
  // supported media API until the 120s fixture budget expires.
  while (Date.now() < deadline) {
    const workerResult = runRealMediaWorkerOnce(mediaId);
    workerIterations += workerResult.worker_iterations ?? 0;
    stdout = workerResult.stdout;
    stderr = workerResult.stderr;

    const response = await page.request.get(`/api/media/${mediaId}`);
    if (response.ok()) {
      const payload = (await response.json()) as {
        data: { processing_status: string; retrieval_status?: string | null };
      };
      const processingStatus = payload.data.processing_status;
      const retrievalStatus = payload.data.retrieval_status ?? "pending";
      last = {
        processing_status: processingStatus,
        retrieval_status: retrievalStatus,
        index_status: workerResult.index_status,
        index_run_state: workerResult.index_run_state,
        chunk_count: workerResult.chunk_count,
        evidence_count: workerResult.evidence_count,
        embedding_count: workerResult.embedding_count,
      };
      if (
        retrievalStatus === "ready" &&
        processingStatus === "ready_for_reading" &&
        workerResult.index_status === "ready" &&
        workerResult.index_run_state === "ready" &&
        (workerResult.chunk_count ?? 0) > 0 &&
        (workerResult.evidence_count ?? 0) > 0 &&
        (workerResult.embedding_count ?? 0) > 0
      ) {
        return {
          status: "success",
          retrieval_status: retrievalStatus,
          processing_status: processingStatus,
          index_status: workerResult.index_status,
          index_run_state: workerResult.index_run_state,
          chunk_count: workerResult.chunk_count,
          evidence_count: workerResult.evidence_count,
          embedding_count: workerResult.embedding_count,
          worker_iterations: workerIterations,
          last,
          stdout,
          stderr,
        };
      }
      if (
        processingStatus === "failed" ||
        ["failed", "no_text", "ocr_required"].includes(retrievalStatus) ||
        ["failed", "no_text", "ocr_required"].includes(
          workerResult.index_status ?? "",
        )
      ) {
        return {
          status: "failed",
          retrieval_status: retrievalStatus,
          processing_status: processingStatus,
          index_status: workerResult.index_status,
          index_run_state: workerResult.index_run_state,
          chunk_count: workerResult.chunk_count,
          evidence_count: workerResult.evidence_count,
          embedding_count: workerResult.embedding_count,
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

export async function searchRealMediaEvidenceThroughUi(
  page: Page,
  query: string,
  contentKind: RealMediaContentKind,
): Promise<RealMediaSearchResponseBody> {
  const searchUrl = `/search?${new URLSearchParams({
    q: query,
    types: "content_chunk",
    content_kinds: contentKind,
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
        url.searchParams.get("types") === "content_chunk" &&
        url.searchParams.get("content_kinds") === contentKind
      );
    },
    { timeout: 60_000 },
  );
  await gotoRealMediaSinglePane(page, searchUrl);
  const searchPane = activeWorkspacePane(page);
  await expect(
    searchPane
      .getByRole("group", { name: "Result types" })
      .getByRole("checkbox", { name: "Evidence", exact: true }),
  ).toBeChecked();
  await expect(
    searchPane
      .getByRole("group", { name: "Content kinds" })
      .getByLabel(CONTENT_KIND_LABELS[contentKind]),
  ).toBeChecked();

  await expect(searchPane.getByLabel("Search content")).toHaveValue(query);
  const response = await responsePromise;
  expect(
    response.ok(),
    `visible search for ${contentKind} should succeed`,
  ).toBeTruthy();
  await expect(searchPane.getByText("Searching...")).toBeHidden({
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
    .getByRole("button", { name: "Options" })
    .first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });

  if (!expectedItem) {
    await trigger.click();
    await expect(page.getByRole("menu").last()).toBeVisible({
      timeout: 5_000,
    });
    return;
  }

  const deadline = Date.now() + 15_000;
  let lastMenuItems: string[] = [];
  while (Date.now() < deadline) {
    await trigger.click();
    await expect(page.getByRole("menu").last()).toBeVisible({ timeout: 2_000 });
    const item = page.getByRole("menuitem", { name: expectedItem }).first();
    if (await item.isVisible().catch(() => false)) {
      return;
    }
    lastMenuItems = (await page.getByRole("menuitem").allTextContents().catch(
      () => [],
    )).map((label) => label.trim()).filter(Boolean);
    await page.keyboard.press("Escape").catch(() => undefined);
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

  const highlightActions = activePane.getByRole("dialog", {
    name: /selection actions/i,
  });
  await expect(highlightActions).toBeVisible({ timeout: 5_000 });
  await highlightActions.getByRole("button", { name: "Highlight color" }).click();
  const highlightColorDialog = page.getByRole("dialog", {
    name: "Highlight color",
  });
  await expect(highlightColorDialog).toBeVisible({ timeout: 5_000 });
  const createdHighlightResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/media/${mediaId}/pdf-highlights`),
  );
  await highlightColorDialog
    .getByRole("button", { name: /^Green/ })
    .first()
    .click();
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
      'dialog[aria-label="Highlight color"] button[aria-label^="Green"]',
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
  const highlightActions = activeWorkspacePane(page).getByRole("dialog", {
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
      .getByRole("dialog", { name: "Highlight color" })
      .getByRole("button", { name: /^Green/ })
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
    const highlightsPane = await openReaderHighlightsPane(page);
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
      'dialog[aria-label="selection actions"] button[aria-label^="Green"]',
    request_url: createdHighlightResponse.url(),
  };
}
