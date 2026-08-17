import type { APIResponse } from "playwright/test";
import { expect, minioOrigin, webOrigin } from "./fixtures";
import type { ExactOriginRequest } from "./request";

export interface PublishedDocumentUpload {
  sessionHandle: string;
  mediaId: string;
  sourceAttemptId: string;
}

interface UploadRequired {
  kind: "UploadRequired";
  session_handle: string;
  generation: number;
  method: "PUT";
  upload_url: string;
  required_headers: Record<string, string>;
}

async function responseData<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(
    response.ok(),
    `${label} failed: ${response.status()} ${body.slice(0, 500)}`,
  ).toBeTruthy();
  return (JSON.parse(body) as { data: T }).data;
}

export async function uploadDocument({
  api,
  objects,
  payload,
  kind,
  filename,
  idempotencyKey,
  libraryIds = [],
  beforeConfirm,
}: {
  api: ExactOriginRequest;
  objects: ExactOriginRequest;
  payload: Buffer;
  kind: "Pdf" | "Epub";
  filename: string;
  idempotencyKey: string;
  libraryIds?: readonly string[];
  beforeConfirm?: (upload: UploadRequired) => Promise<void>;
}): Promise<PublishedDocumentUpload> {
  const contentType =
    kind === "Pdf" ? "application/pdf" : "application/epub+zip";
  const upload = await responseData<UploadRequired>(
    await api.post("/api/media/uploads", {
      headers: { origin: webOrigin, "Idempotency-Key": idempotencyKey },
      data: {
        kind,
        filename,
        content_type: contentType,
        size_bytes: payload.byteLength,
        library_ids: libraryIds,
      },
    }),
    `${kind} upload-session creation`,
  );
  expect(upload.kind).toBe("UploadRequired");
  expect(upload.method).toBe("PUT");
  expect(new URL(upload.upload_url).origin).toBe(minioOrigin);

  const uploaded = await objects.put(upload.upload_url, {
    headers: upload.required_headers,
    data: payload,
  });
  expect(
    uploaded.ok(),
    `${kind} object upload failed with ${uploaded.status()}.`,
  ).toBeTruthy();
  await beforeConfirm?.(upload);

  const published = await responseData<{
    kind: "Published";
    session_handle: string;
    media_id: string;
    source_attempt_id: string;
  }>(
    await api.post(
      `/api/media/uploads/${encodeURIComponent(upload.session_handle)}/confirm`,
      {
        headers: { origin: webOrigin },
        data: { generation: upload.generation },
      },
    ),
    `${kind} upload confirmation`,
  );
  expect(published).toMatchObject({
    kind: "Published",
    session_handle: upload.session_handle,
  });
  return {
    sessionHandle: published.session_handle,
    mediaId: published.media_id,
    sourceAttemptId: published.source_attempt_id,
  };
}
