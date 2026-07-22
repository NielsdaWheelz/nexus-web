import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFromUrlResponse,
  decodeIngestResponse,
  getFileUploadError,
  matchesAcceptedUploadIdentity,
  MediaIngestionContractDefect,
  projectUploadInitResponse,
  projectUploadReference,
  uploadIngestFile,
} from "./ingestionClient";

afterEach(() => vi.restoreAllMocks());

function acceptedFields(overrides: Record<string, unknown> = {}) {
  return {
    media_id: "media-1",
    source_attempt_id: "attempt-1",
    source_type: "uploaded_pdf_file",
    source_attempt_status: "queued",
    idempotency_outcome: "created",
    processing_status: "pending",
    ingest_enqueued: true,
    ...overrides,
  };
}

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

  it("rejects unsupported and empty files before upload initialization", () => {
    expect(
      getFileUploadError(
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ),
    ).toBe("Only PDF and EPUB files are supported.");
    expect(
      getFileUploadError(
        new File([], "empty.pdf", { type: "application/pdf" }),
      ),
    ).toBe("PDF files must not be empty.");
  });

  it("rejects files above the product upload caps", () => {
    const file = new File(["x"], "book.epub", { type: "application/epub+zip" });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });

    expect(getFileUploadError(file)).toBe(
      "EPUB files must be 50 MB or smaller.",
    );
  });
});

describe("source ingest response decoding", () => {
  it("derives URL reuse from the idempotency outcome", () => {
    expect(
      decodeFromUrlResponse({
        data: acceptedFields({ idempotency_outcome: "reused" }),
      }),
    ).toMatchObject({
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      idempotencyOutcome: "reused",
      duplicate: true,
      processingStatus: "pending",
    });
  });

  it("takes upload deduplication from the confirm response", () => {
    expect(
      decodeIngestResponse({ data: acceptedFields({ duplicate: true }) }),
    ).toMatchObject({ duplicate: true, ingestEnqueued: true });
  });

  it("defects on invalid same-system response fields", () => {
    expect(() =>
      decodeFromUrlResponse({
        data: acceptedFields({ processing_status: "invented" }),
      }),
    ).toThrow(MediaIngestionContractDefect);
    expect(() =>
      decodeFromUrlResponse({
        data: acceptedFields({ source_attempt_status: "invented" }),
      }),
    ).toThrow("unsupported source_attempt_status");
    expect(() => decodeIngestResponse({ data: acceptedFields() })).toThrow(
      "duplicate must be a boolean",
    );
  });
});

describe("upload init outcome projection", () => {
  it("requires upload when init returns a signed URL", () => {
    expect(
      projectUploadInitResponse({
        data: acceptedFields({
          source_attempt_status: "accepted",
          ingest_enqueued: false,
          upload_url: "https://uploads.example/paper.pdf",
        }),
      }),
    ).toEqual({
      kind: "UploadRequired",
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      uploadUrl: "https://uploads.example/paper.pdf",
    });
  });

  it("preserves the actual accepted processing failure when signing failed", () => {
    expect(
      projectUploadInitResponse({
        data: acceptedFields({
          source_attempt_status: "failed",
          processing_status: "failed",
          ingest_enqueued: false,
          upload_url: null,
        }),
      }),
    ).toMatchObject({
      kind: "Accepted",
      result: {
        mediaId: "media-1",
        sourceAttemptStatus: "failed",
        processingStatus: "failed",
        ingestEnqueued: false,
      },
    });
  });

  it("preserves reused acceptance when init replays after upload confirmation", () => {
    expect(
      projectUploadInitResponse({
        data: acceptedFields({
          source_attempt_status: "queued",
          idempotency_outcome: "reused",
          upload_url: null,
        }),
      }),
    ).toMatchObject({
      kind: "Accepted",
      result: {
        idempotencyOutcome: "reused",
        duplicate: true,
      },
    });
  });

  it("keeps accepted identity uncertain while confirmation is in progress", () => {
    expect(
      projectUploadInitResponse({
        data: acceptedFields({
          source_attempt_status: "accepted",
          ingest_enqueued: false,
          upload_url: null,
        }),
      }),
    ).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      feedback: { severity: "warning" },
    });
  });
});

describe("upload reference projection", () => {
  const processingFailureFeedback = {
    severity: "warning" as const,
    title: "Attachment was added, but source processing failed.",
  };

  it("projects settled, processing-failed, and uncertain accepted identities", () => {
    const settled = decodeIngestResponse({
      data: acceptedFields({
        duplicate: false,
        processing_status: "ready_for_reading",
      }),
    });
    const failed = decodeIngestResponse({
      data: acceptedFields({ duplicate: false, processing_status: "failed" }),
    });
    const uncertainFeedback = {
      severity: "warning" as const,
      title: "Upload status could not be confirmed.",
    };

    expect(
      projectUploadReference({
        result: { kind: "Accepted", result: settled },
        processingFailureFeedback,
      }),
    ).toEqual({ mediaId: "media-1", warning: null });
    expect(
      projectUploadReference({
        result: { kind: "Accepted", result: failed },
        processingFailureFeedback,
      }),
    ).toEqual({ mediaId: "media-1", warning: processingFailureFeedback });
    expect(
      projectUploadReference({
        result: {
          kind: "AcceptedUncertain",
          mediaId: "media-uncertain",
          sourceAttemptId: "attempt-uncertain",
          feedback: uncertainFeedback,
        },
        processingFailureFeedback,
      }),
    ).toEqual({ mediaId: "media-uncertain", warning: uncertainFeedback });
  });

  it("matches both durable upload identity fields", () => {
    const accepted = {
      kind: "Accepted" as const,
      result: decodeIngestResponse({
        data: acceptedFields({ duplicate: false }),
      }),
    };
    const uncertain = {
      kind: "AcceptedUncertain" as const,
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
      feedback: { severity: "warning" as const, title: "Status unknown" },
    };

    for (const result of [accepted, uncertain]) {
      expect(
        matchesAcceptedUploadIdentity(result, {
          mediaId: "media-1",
          sourceAttemptId: "attempt-1",
        }),
      ).toBe(true);
      expect(
        matchesAcceptedUploadIdentity(result, {
          mediaId: "media-other",
          sourceAttemptId: "attempt-1",
        }),
      ).toBe(false);
      expect(
        matchesAcceptedUploadIdentity(result, {
          mediaId: "media-1",
          sourceAttemptId: "attempt-other",
        }),
      ).toBe(false);
    }
  });
});

describe("signed upload failure classification", () => {
  const file = new File(["%PDF-1.7"], "paper.pdf", {
    type: "application/pdf",
  });

  function installUploadFailure(error: unknown) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload/init")) {
        return Response.json({
          data: acceptedFields({
            source_attempt_status: "accepted",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/paper.pdf",
            expires_at: "2026-01-01T00:00:00Z",
          }),
        });
      }
      if (url === "https://uploads.example/paper.pdf") throw error;
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("publishes accepted identity and defects on an unclassified PUT failure", async () => {
    installUploadFailure(new Error("programmer failure"));
    const onAcceptedIdentity = vi.fn();

    await expect(
      uploadIngestFile({ file, libraryIds: [], onAcceptedIdentity }),
    ).rejects.toBeInstanceOf(MediaIngestionContractDefect);
    expect(onAcceptedIdentity).toHaveBeenCalledWith({
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
    });
  });

  it("defects on a definitive signed-PUT HTTP rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload/init")) {
        return Response.json({
          data: acceptedFields({
            source_attempt_status: "accepted",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/paper.pdf",
          }),
        });
      }
      if (url === "https://uploads.example/paper.pdf") {
        return new Response(null, { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(uploadIngestFile({ file, libraryIds: [] })).rejects.toThrow(
      "Signed upload returned unexpected status 503",
    );
  });

  it.each([
    ["TypeError", new TypeError("network failed")],
    [
      "non-abort DOMException",
      new DOMException("network failed", "NetworkError"),
    ],
  ])("keeps accepted identity uncertain for %s", async (_name, error) => {
    installUploadFailure(error);

    await expect(
      uploadIngestFile({ file, libraryIds: [] }),
    ).resolves.toMatchObject({
      kind: "AcceptedUncertain",
      mediaId: "media-1",
      sourceAttemptId: "attempt-1",
    });
  });
});

describe("upload confirmation identity", () => {
  it("defects when confirmation changes the durable init identity", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload/init")) {
        return Response.json({
          data: acceptedFields({
            source_attempt_status: "accepted",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/paper.pdf",
          }),
        });
      }
      if (
        url === "https://uploads.example/paper.pdf" &&
        init?.method === "PUT"
      ) {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/api/media/media-1/ingest")) {
        return Response.json({
          data: acceptedFields({
            media_id: "media-other",
            duplicate: false,
          }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      uploadIngestFile({
        file: new File(["%PDF-1.7"], "paper.pdf", {
          type: "application/pdf",
        }),
        libraryIds: [],
        idempotencyKey: "upload-key",
      }),
    ).rejects.toThrow("changed the accepted upload identity");
  });
});
