import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  addMediaFromUrl,
  getFileUploadError,
  refreshMediaSource,
  retryMediaMetadata,
  retryMediaSource,
  uploadIngestFile,
} from "./ingestionClient";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);
const fetchMock = vi.spyOn(globalThis, "fetch");

const capabilities = {
  can_read: false,
  can_highlight: false,
  can_quote: false,
  can_search: false,
  can_play: false,
  can_download_file: false,
  can_delete: true,
  can_retry: false,
  can_refresh_source: false,
  can_retry_metadata: false,
};

describe("getFileUploadError", () => {
  it("accepts PDF and EPUB files inside the upload limits", () => {
    expect(
      getFileUploadError(
        new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
      ),
    ).toBeNull();
    expect(
      getFileUploadError(
        new File(["PK\u0003\u0004"], "book.epub", {
          type: "application/epub+zip",
        }),
      ),
    ).toBeNull();
  });

  it("rejects unsupported files before upload initialization", () => {
    expect(
      getFileUploadError(
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ),
    ).toBe("Only PDF and EPUB files are supported.");
  });

  it("rejects files above the product upload caps", () => {
    const file = new File([""], "book.epub", { type: "application/epub+zip" });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });

    expect(getFileUploadError(file)).toBe(
      "EPUB files must be 50 MB or smaller.",
    );
  });
});

describe("source ingest actions", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchMock.mockReset();
  });

  it("posts the source retry stage and maps the shared source response", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        media_id: "media-1",
        source_attempt_id: "attempt-1",
        source_type: "generic_web_url",
        source_attempt_status: "queued",
        idempotency_outcome: "retrying",
        processing_status: "extracting",
        ingest_enqueued: true,
        capabilities,
      },
    });

    await expect(
      retryMediaSource("media-1", { idempotencyKey: "retry-key-1" }),
    ).resolves.toMatchObject({
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      sourceAttemptStatus: "queued",
      idempotencyOutcome: "retrying",
      processingStatus: "extracting",
      ingestEnqueued: true,
      capabilities,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/retry", {
      method: "POST",
      headers: { "Idempotency-Key": "retry-key-1" },
      body: JSON.stringify({ from_stage: "source" }),
    });
  });

  it("posts refresh through the shared source endpoint contract", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        media_id: "media-1",
        source_attempt_id: "attempt-2",
        source_type: "generic_web_url",
        source_attempt_status: "failed",
        idempotency_outcome: "refreshed",
        processing_status: "failed",
        ingest_enqueued: false,
        capabilities: { ...capabilities, can_retry: true },
      },
    });

    await expect(
      refreshMediaSource("media-1", { idempotencyKey: "refresh-key-1" }),
    ).resolves.toMatchObject({
      mediaId: "media-1",
      sourceAttemptId: "attempt-2",
      sourceAttemptStatus: "failed",
      idempotencyOutcome: "refreshed",
      processingStatus: "failed",
      ingestEnqueued: false,
      capabilities: { ...capabilities, can_retry: true },
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/refresh", {
      method: "POST",
      headers: { "Idempotency-Key": "refresh-key-1" },
    });
  });

  it("keeps metadata retry separate from source ingest", async () => {
    apiFetchMock.mockResolvedValueOnce({ data: { ok: true } });

    await retryMediaMetadata("media-1");

    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/retry", {
      method: "POST",
      body: JSON.stringify({ from_stage: "metadata" }),
    });
  });

  it("generates an idempotency key for URL source ingest by default", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        media_id: "media-1",
        source_attempt_id: "attempt-1",
        source_type: "generic_web_url",
        source_attempt_status: "queued",
        idempotency_outcome: "created",
        processing_status: "pending",
        ingest_enqueued: true,
      },
    });

    await addMediaFromUrl({
      url: "https://example.com/article",
      libraryIds: ["library-1"],
    });

    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/from-url", {
      method: "POST",
      headers: { "Idempotency-Key": expect.stringMatching(/^media-url-/) },
      body: JSON.stringify({
        url: "https://example.com/article",
        library_ids: ["library-1"],
      }),
    });
  });

  it("maps a saved upload-init signing failure without direct upload", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        media_id: "media-1",
        source_attempt_id: "attempt-1",
        source_type: "uploaded_pdf_file",
        source_attempt_status: "failed",
        idempotency_outcome: "created",
        processing_status: "failed",
        ingest_enqueued: false,
        upload_url: null,
        expires_at: "2026-06-04T12:00:00Z",
      },
    });

    await expect(
      uploadIngestFile({
        file: new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
        libraryIds: [],
        idempotencyKey: "upload-key-1",
      }),
    ).resolves.toMatchObject({
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      sourceAttemptStatus: "failed",
      processingStatus: "failed",
      ingestEnqueued: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/upload/init", {
      method: "POST",
      headers: { "Idempotency-Key": "upload-key-1" },
      body: JSON.stringify({
        kind: "pdf",
        filename: "paper.pdf",
        content_type: "application/pdf",
        size_bytes: 8,
        library_ids: [],
      }),
    });
  });
});
