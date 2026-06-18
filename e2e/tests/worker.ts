import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import supabaseEnv from "../supabase-env.cjs";

const { buildE2eAppRuntimeEnv } = supabaseEnv;

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const LOCAL_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const LOCAL_STORAGE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "minio",
]);
const WORKER_ITERATION_TIMEOUT_MS = 30_000;
const STARTED_WORKER_TIMEOUT_MS = 120_000;

export interface E2eWorkerIterationIndex {
  processing_status?: string | null;
  index_status?: string | null;
  chunk_count: number;
  evidence_count: number;
  embedding_count: number;
}

export interface E2eWorkerIterationResult {
  processed: boolean;
  chatRunStatus?: string | null;
  index: E2eWorkerIterationIndex | null;
  stdout: string;
  stderr: string;
}

interface RunE2eWorkerOnceOptions {
  mediaId?: string;
  allowedNexusEnvs?: readonly string[];
  extraEnv?: Record<string, string | undefined>;
}

interface StartE2eWorkerUntilChatRunTerminalOptions extends RunE2eWorkerOnceOptions {
  chatRunId: string;
}

function assertAllowedNexusEnv(allowedNexusEnvs: readonly string[]): string {
  const nexusEnv = process.env.NEXUS_ENV ?? "local";
  if (!allowedNexusEnvs.includes(nexusEnv)) {
    throw new Error(
      `Refusing to run E2E worker with NEXUS_ENV=${nexusEnv}; allowed values: ${allowedNexusEnvs.join(
        ", ",
      )}.`,
    );
  }
  return nexusEnv;
}

function assertLocalDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to drain the E2E worker.");
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

  if (!LOCAL_DATABASE_HOSTS.has(databaseHost)) {
    throw new Error(
      `Refusing to run E2E worker against non-local database host ${databaseHost}.`,
    );
  }

  return databaseUrl;
}

function assertLocalStorageEndpoint(
  env: Record<string, string | undefined>,
): void {
  if (
    env.E2E_ALLOW_NON_LOCAL_STORAGE === "1" ||
    env.REAL_MEDIA_ALLOW_NON_LOCAL_STORAGE === "1"
  ) {
    return;
  }

  const endpointUrl = env.R2_S3_API_ORIGIN;
  if (!endpointUrl) {
    return;
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

  if (!LOCAL_STORAGE_HOSTS.has(host) && !host.endsWith(".localhost")) {
    throw new Error(
      `Refusing to run E2E worker against non-local R2/MinIO endpoint ${endpointUrl}.`,
    );
  }
}

export function runE2eWorkerOnce({
  mediaId,
  allowedNexusEnvs = ["local", "test"],
  extraEnv = {},
}: RunE2eWorkerOnceOptions = {}): E2eWorkerIterationResult {
  const databaseUrl = assertLocalDatabaseUrl();
  const nexusEnv = assertAllowedNexusEnv(allowedNexusEnvs);
  const workerEnv = {
    ...buildE2eAppRuntimeEnv(process.env),
    DATABASE_URL: databaseUrl,
    NEXUS_ENV: nexusEnv,
    ...extraEnv,
    ...(mediaId ? { NEXUS_E2E_WORKER_MEDIA_ID: mediaId } : {}),
  };
  assertLocalStorageEndpoint(workerEnv);

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
media_id = os.environ.get("NEXUS_E2E_WORKER_MEDIA_ID")
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
                    count(DISTINCT cc.id),
                    count(DISTINCT es.id),
                    count(DISTINCT ce.id)
                FROM media m
                LEFT JOIN content_index_states mcis ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
                LEFT JOIN content_chunks cc ON cc.owner_kind = 'media' AND cc.owner_id = m.id
                LEFT JOIN evidence_spans es ON es.owner_kind = 'media' AND es.owner_id = m.id
                LEFT JOIN content_embeddings ce ON ce.chunk_id = cc.id
                WHERE m.id = %s::uuid
                GROUP BY m.processing_status, mcis.status
                """,
                (media_id,),
            )
            row = cur.fetchone()
    payload["index"] = None if row is None else {
        "processing_status": row[0],
        "index_status": row[1],
        "chunk_count": row[2],
        "evidence_count": row[3],
        "embedding_count": row[4],
    }
print(json.dumps(payload, sort_keys=True))
	`,
    ],
    {
      cwd: ROOT_DIR,
      env: workerEnv,
      encoding: "utf-8",
      timeout: WORKER_ITERATION_TIMEOUT_MS,
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
        processing_status?: string | null;
        index_status?: string | null;
        chunk_count?: number;
        evidence_count?: number;
        embedding_count?: number;
      }
    | null
    | undefined;

  return {
    processed: result.processed === true,
    index: index
      ? {
          processing_status: index.processing_status ?? null,
          index_status: index.index_status ?? null,
          chunk_count: Number(index.chunk_count ?? 0),
          evidence_count: Number(index.evidence_count ?? 0),
          embedding_count: Number(index.embedding_count ?? 0),
        }
      : null,
    stdout: child.stdout.slice(-4000),
    stderr: child.stderr.slice(-4000),
  };
}

export function startE2eWorkerUntilChatRunTerminal({
  chatRunId,
  mediaId,
  allowedNexusEnvs = ["local", "test"],
  extraEnv = {},
}: StartE2eWorkerUntilChatRunTerminalOptions): Promise<E2eWorkerIterationResult> {
  const databaseUrl = assertLocalDatabaseUrl();
  const nexusEnv = assertAllowedNexusEnv(allowedNexusEnvs);
  const workerEnv = {
    ...buildE2eAppRuntimeEnv(process.env),
    DATABASE_URL: databaseUrl,
    NEXUS_ENV: nexusEnv,
    ...extraEnv,
    ...(mediaId ? { NEXUS_E2E_WORKER_MEDIA_ID: mediaId } : {}),
    NEXUS_E2E_WORKER_CHAT_RUN_ID: chatRunId,
  };
  assertLocalStorageEndpoint(workerEnv);

  const child = spawn(
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
import time

import psycopg

from apps.worker.main import create_worker

database_url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
run_id = os.environ["NEXUS_E2E_WORKER_CHAT_RUN_ID"]
terminal = {"cancelled", "complete", "error"}
deadline = time.monotonic() + 100
processed = False
status = None
worker = create_worker()

while time.monotonic() < deadline:
    processed = bool(worker.run_once()) or processed
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM chat_runs WHERE id = %s::uuid", (run_id,))
            row = cur.fetchone()
    status = row[0] if row is not None else None
    if status in terminal:
        print(json.dumps({"processed": processed, "chatRunStatus": status}, sort_keys=True))
        break
    time.sleep(0.1)
else:
    raise TimeoutError(f"chat run {run_id} did not reach terminal status; last status={status}")
`,
    ],
    { cwd: ROOT_DIR, env: workerEnv },
  );
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(
    () => child.kill("SIGKILL"),
    STARTED_WORKER_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(stderr || stdout || `worker exited with ${signal ?? code}`),
        );
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const result = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<
        string,
        unknown
      >;
      resolve({
        processed: result.processed === true,
        chatRunStatus:
          typeof result.chatRunStatus === "string"
            ? result.chatRunStatus
            : null,
        index: null,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
    });
  });
}
