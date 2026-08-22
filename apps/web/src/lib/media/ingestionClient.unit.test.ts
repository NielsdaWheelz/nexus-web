import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  UploadSessionError,
  uploadSessionOutcome,
  type UploadSessionEndpoint,
  type UploadSessionOutcome,
} from "./ingestionClient";
import { acceptanceErrorMessage } from "@/components/nexus/addContentSessionModel";
import { uploadSessionActionErrorMessage } from "@/lib/status/mediaActivity";

/**
 * Oracle: the upload-session API contract (spec §5 of
 * docs/cutovers/document-import-reliability-hard-cutover.md and the
 * per-endpoint error table it declares). Every declared code must reach the
 * user as its own next step; none of them may be laundered into the
 * same-system defect boundary that replaces the Add sheet.
 */
const DECLARED_CODES: readonly [
  UploadSessionEndpoint,
  number,
  string,
  UploadSessionOutcome,
  "Rejected" | "Unresolved" | "Superseded" | "Defect",
][] = [
  ["Create", 400, "E_INVALID_REQUEST", { kind: "IntentMalformed" }, "Defect"],
  [
    "Create",
    400,
    "E_INVALID_FILE_TYPE",
    { kind: "UnsupportedFileType" },
    "Rejected",
  ],
  ["Create", 400, "E_FILE_TOO_LARGE", { kind: "FileTooLarge" }, "Rejected"],
  ["Create", 403, "E_FORBIDDEN", { kind: "LibraryForbidden" }, "Rejected"],
  [
    "Create",
    403,
    "E_LIBRARY_FORBIDDEN",
    { kind: "LibraryForbidden" },
    "Rejected",
  ],
  [
    "Create",
    404,
    "E_UPLOAD_SESSION_NOT_FOUND",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Create",
    409,
    "E_IDEMPOTENCY_CONFLICT",
    { kind: "IntentChanged" },
    "Rejected",
  ],
  [
    "Create",
    409,
    "E_UPLOAD_VERIFICATION_IN_PROGRESS",
    { kind: "Unresolved" },
    "Unresolved",
  ],
  [
    "Create",
    500,
    "E_SIGN_UPLOAD_FAILED",
    { kind: "Unresolved" },
    "Unresolved",
  ],
  [
    "TransportFailure",
    400,
    "E_INVALID_REQUEST",
    { kind: "IntentMalformed" },
    "Defect",
  ],
  [
    "TransportFailure",
    404,
    "E_UPLOAD_SESSION_NOT_FOUND",
    { kind: "Superseded" },
    "Superseded",
  ],
  ["Retry", 400, "E_INVALID_REQUEST", { kind: "IntentMalformed" }, "Defect"],
  [
    "Retry",
    404,
    "E_UPLOAD_SESSION_NOT_FOUND",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Retry",
    409,
    "E_UPLOAD_ALREADY_PUBLISHED",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Retry",
    409,
    "E_UPLOAD_INTENT_MISMATCH",
    { kind: "FileMismatch" },
    "Rejected",
  ],
  [
    "Retry",
    409,
    "E_UPLOAD_VERIFICATION_IN_PROGRESS",
    { kind: "Unresolved" },
    "Unresolved",
  ],
  ["Retry", 500, "E_SIGN_UPLOAD_FAILED", { kind: "Unresolved" }, "Unresolved"],
  ["Confirm", 400, "E_INVALID_REQUEST", { kind: "IntentMalformed" }, "Defect"],
  [
    "Confirm",
    403,
    "E_LIBRARY_FORBIDDEN",
    { kind: "LibraryForbidden" },
    "Rejected",
  ],
  [
    "Confirm",
    404,
    "E_UPLOAD_SESSION_NOT_FOUND",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Confirm",
    409,
    "E_UPLOAD_GENERATION_STALE",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Confirm",
    409,
    "E_UPLOAD_VERIFICATION_IN_PROGRESS",
    { kind: "Unresolved" },
    "Unresolved",
  ],
  ["Confirm", 400, "E_STORAGE_MISSING", { kind: "BytesMissing" }, "Unresolved"],
  [
    "Confirm",
    400,
    "E_SOURCE_INTEGRITY",
    { kind: "VerificationRejected", code: "E_SOURCE_INTEGRITY" },
    "Rejected",
  ],
  [
    "Confirm",
    400,
    "E_INVALID_FILE_TYPE",
    { kind: "VerificationRejected", code: "E_INVALID_FILE_TYPE" },
    "Rejected",
  ],
  [
    "Confirm",
    400,
    "E_FILE_TOO_LARGE",
    { kind: "VerificationRejected", code: "E_FILE_TOO_LARGE" },
    "Rejected",
  ],
  ["Confirm", 500, "E_STORAGE_ERROR", { kind: "Unresolved" }, "Unresolved"],
  [
    "Remove",
    404,
    "E_UPLOAD_SESSION_NOT_FOUND",
    { kind: "Superseded" },
    "Superseded",
  ],
  [
    "Remove",
    409,
    "E_UPLOAD_ALREADY_PUBLISHED",
    { kind: "Superseded" },
    "Superseded",
  ],
];

function apiError(status: number, code: string): ApiError {
  return new ApiError(status, code, `${code} from the upload session API`);
}

describe("upload-session error contract", () => {
  it.each(DECLARED_CODES)(
    "maps %s %d %s to its declared client outcome",
    (endpoint, status, code, outcome) => {
      expect(
        uploadSessionOutcome(endpoint, apiError(status, code)),
        `${endpoint} did not declare ${code}`,
      ).toEqual(outcome);
    },
  );

  it.each(DECLARED_CODES)(
    "settles %s %d %s in the Add sheet without a same-system defect",
    (_endpoint, _status, code, outcome, acceptance) => {
      const failure = acceptanceErrorMessage(new UploadSessionError(outcome));
      expect(
        failure.kind,
        `${code} reached the Add sheet as ${failure.kind}`,
      ).toBe(acceptance);
      if (failure.kind === "Rejected" || failure.kind === "Unresolved") {
        expect(failure.feedback.title.length).toBeGreaterThan(0);
        expect(failure.feedback.message?.length ?? 0).toBeGreaterThan(0);
      }
    },
  );

  it.each(
    DECLARED_CODES.filter(([, , , outcome]) => outcome.kind !== "IntentMalformed"),
  )(
    "gives %s %d %s one truthful Import Activity next step",
    (_endpoint, _status, _code, outcome) => {
      expect(
        uploadSessionActionErrorMessage(new UploadSessionError(outcome)).length,
      ).toBeGreaterThan(0);
    },
  );

  it("classifies E_STORAGE_MISSING as an incomplete upload, not an unknown status", () => {
    const failure = acceptanceErrorMessage(
      new UploadSessionError({ kind: "BytesMissing" }),
    );
    if (failure.kind !== "Unresolved") {
      throw new Error(`expected an unresolved item, got ${failure.kind}`);
    }
    expect(failure.reason).toBe("UploadIncomplete");
  });

  it.each([
    ["Confirm" as const, "E_UPSTREAM_TIMEOUT", 504],
    ["Create" as const, "E_UPSTREAM", 503],
    ["Confirm" as const, "E_INTERNAL", 500],
    ["Remove" as const, "E_UPLOAD_GENERATION_STALE", 409],
  ])(
    "leaves %s %s to the generic API error channel",
    (endpoint, code, status) => {
      expect(uploadSessionOutcome(endpoint, apiError(status, code))).toBeNull();
    },
  );

  it("keeps an undeclared 5xx an unresolved acceptance instead of a defect", () => {
    expect(
      acceptanceErrorMessage(apiError(504, "E_UPSTREAM_TIMEOUT")).kind,
    ).toBe("Unresolved");
    expect(acceptanceErrorMessage(apiError(500, "E_SIGN_UPLOAD_FAILED")).kind).toBe(
      "Unresolved",
    );
  });

  it("keeps a same-system response defect a defect", () => {
    expect(uploadSessionOutcome("Confirm", apiError(200, "E_INVALID_RESPONSE"))).toBeNull();
    expect(
      acceptanceErrorMessage(apiError(200, "E_INVALID_RESPONSE")).kind,
    ).toBe("Defect");
  });
});
