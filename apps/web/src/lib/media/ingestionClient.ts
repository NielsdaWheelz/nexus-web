"use client";

import { apiFetch } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";

type FileKind = "pdf" | "epub";

interface UploadInitResponse {
  data: {
    media_id: string;
    source_attempt_id: string;
    source_type: string;
    source_attempt_status: string;
    idempotency_outcome: "created" | "reused" | "retrying" | "refreshed";
    processing_status: string;
    ingest_enqueued: boolean;
    upload_url: string | null;
    expires_at: string;
  };
}

interface IngestResponse {
  data: {
    media_id: string;
    source_attempt_id: string;
    source_type: string;
    source_attempt_status: string;
    idempotency_outcome: "created" | "reused" | "retrying" | "refreshed";
    duplicate: boolean;
    processing_status: string;
    ingest_enqueued: boolean;
  };
}

interface FromUrlResponse {
  data: {
    media_id: string;
    source_attempt_id: string;
    source_type: string;
    source_attempt_status: string;
    idempotency_outcome: "created" | "reused" | "retrying" | "refreshed";
    processing_status: string;
    ingest_enqueued: boolean;
  };
}

interface SourceActionResponse {
  data: {
    media_id: string;
    source_attempt_id: string;
    source_type: string;
    source_attempt_status: string;
    idempotency_outcome: "created" | "reused" | "retrying" | "refreshed";
    processing_status: string;
    ingest_enqueued: boolean;
    capabilities: MediaActionCapabilities;
  };
}

export interface MediaActionCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
  can_delete: boolean;
  can_retry: boolean;
  can_refresh_source: boolean;
  can_retry_metadata: boolean;
}

export interface SourceIngestResult {
  mediaId: string;
  sourceAttemptId: string;
  sourceType: string;
  sourceAttemptStatus: string;
  idempotencyOutcome: "created" | "reused" | "retrying" | "refreshed";
  duplicate: boolean;
  processingStatus: string;
  ingestEnqueued: boolean;
}

export interface SourceActionResult extends SourceIngestResult {
  capabilities: MediaActionCapabilities;
}

export function isFailedSourceIngest(result: SourceIngestResult): boolean {
  return (
    result.processingStatus === "failed" || result.sourceAttemptStatus === "failed"
  );
}

function getFileKind(file: File): FileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) {
    return "epub";
  }
  return null;
}

function contentTypeFor(kind: FileKind): string {
  return kind === "pdf" ? "application/pdf" : "application/epub+zip";
}

export function getFileUploadError(file: File): string | null {
  const kind = getFileKind(file);
  if (!kind) {
    return "Only PDF and EPUB files are supported.";
  }

  const maxBytes = kind === "pdf" ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    return `${kind.toUpperCase()} files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`;
  }

  return null;
}

export async function uploadIngestFile({
  file,
  libraryIds,
  idempotencyKey = createRandomId("media-upload"),
}: {
  file: File;
  libraryIds: string[];
  idempotencyKey?: string;
}): Promise<SourceIngestResult> {
  const kind = getFileKind(file);
  if (!kind) {
    throw new Error("Only PDF and EPUB files are supported.");
  }

  const init = await apiFetch<UploadInitResponse>("/api/media/upload/init", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      kind,
      filename: file.name,
      content_type: contentTypeFor(kind),
      size_bytes: file.size,
      library_ids: libraryIds,
    }),
  });

  if (!init.data.upload_url) {
    return failedUploadResult(init);
  }

  let uploadOk = false;
  try {
    const upload = await fetch(init.data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": contentTypeFor(kind),
      },
      body: file,
    });
    uploadOk = upload.ok;
  } catch {
    uploadOk = false;
  }

  if (!uploadOk) {
    try {
      const failedIngest = await confirmUploadedMedia(init.data.media_id, libraryIds);
      return mapIngestResponse(failedIngest);
    } catch {
      return failedUploadResult(init);
    }
  }

  let ingest: IngestResponse;
  try {
    ingest = await confirmUploadedMedia(init.data.media_id, libraryIds);
  } catch {
    return failedUploadResult(init);
  }

  return mapIngestResponse(ingest);
}

async function confirmUploadedMedia(
  mediaId: string,
  libraryIds: string[],
): Promise<IngestResponse> {
  return apiFetch<IngestResponse>(`/api/media/${mediaId}/ingest`, {
    method: "POST",
    body: JSON.stringify({ library_ids: libraryIds }),
  });
}

function mapIngestResponse(ingest: IngestResponse): SourceIngestResult {
  return {
    mediaId: ingest.data.media_id,
    sourceAttemptId: ingest.data.source_attempt_id,
    sourceType: ingest.data.source_type,
    sourceAttemptStatus: ingest.data.source_attempt_status,
    idempotencyOutcome: ingest.data.idempotency_outcome,
    duplicate: ingest.data.duplicate,
    processingStatus: ingest.data.processing_status,
    ingestEnqueued: ingest.data.ingest_enqueued,
  };
}

function failedUploadResult(init: UploadInitResponse): SourceIngestResult {
  return {
    mediaId: init.data.media_id,
    sourceAttemptId: init.data.source_attempt_id,
    sourceType: init.data.source_type,
    sourceAttemptStatus: "failed",
    idempotencyOutcome: init.data.idempotency_outcome,
    duplicate: false,
    processingStatus: "failed",
    ingestEnqueued: false,
  };
}

export async function addMediaFromUrl({
  url,
  libraryIds,
  idempotencyKey = createRandomId("media-url"),
}: {
  url: string;
  libraryIds: string[];
  idempotencyKey?: string;
}): Promise<SourceIngestResult> {
  const response = await apiFetch<FromUrlResponse>("/api/media/from-url", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ url, library_ids: libraryIds }),
  });

  return mapAcceptedSourceResponse(response, {
    duplicate: response.data.idempotency_outcome === "reused",
  });
}

export async function retryMediaSource(
  mediaId: string,
  {
    idempotencyKey = createRandomId("media-source-retry"),
  }: { idempotencyKey?: string } = {},
): Promise<SourceActionResult> {
  const response = await apiFetch<SourceActionResponse>(`/api/media/${mediaId}/retry`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from_stage: "source" }),
  });
  return mapSourceActionResponse(response);
}

export async function refreshMediaSource(
  mediaId: string,
  {
    idempotencyKey = createRandomId("media-source-refresh"),
  }: { idempotencyKey?: string } = {},
): Promise<SourceActionResult> {
  const response = await apiFetch<SourceActionResponse>(`/api/media/${mediaId}/refresh`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return mapSourceActionResponse(response);
}

export function retryMediaMetadata<T = unknown>(mediaId: string): Promise<T> {
  return apiFetch<T>(`/api/media/${mediaId}/retry`, {
    method: "POST",
    body: JSON.stringify({ from_stage: "metadata" }),
  });
}

function mapAcceptedSourceResponse(
  response: FromUrlResponse,
  { duplicate = false }: { duplicate?: boolean } = {},
): SourceIngestResult {
  return {
    mediaId: response.data.media_id,
    sourceAttemptId: response.data.source_attempt_id,
    sourceType: response.data.source_type,
    sourceAttemptStatus: response.data.source_attempt_status,
    idempotencyOutcome: response.data.idempotency_outcome,
    duplicate,
    processingStatus: response.data.processing_status,
    ingestEnqueued: response.data.ingest_enqueued,
  };
}

function mapSourceActionResponse(response: SourceActionResponse): SourceActionResult {
  return {
    ...mapAcceptedSourceResponse(response),
    capabilities: response.data.capabilities,
  };
}
