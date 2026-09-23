// The upload-session wire contract every direct-upload client decodes: the
// three enveloped response variants of the one upload lifecycle, the failure a
// NeedsAttention session carries, and the strict decoder that admits them. It
// depends on nothing but the validation primitives and the verification
// vocabulary, so the extension bundle carries it without the web transport.

import {
  UPLOAD_VERIFICATION_CODES,
  decodeUploadTransportFailure,
  type UploadTransportFailure,
  type UploadVerificationCode,
} from "@/lib/media/uploadVerification";
import {
  expectBoolean,
  expectExactRecord,
  expectIsoInstant,
  expectNonemptyString,
  expectNonnegativeInteger,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

const UPLOAD_IDEMPOTENCY_OUTCOMES = ["Created", "Reused"] as const;

export type UploadResponse =
  | {
      readonly kind: "UploadRequired";
      readonly sessionHandle: string;
      readonly generation: number;
      readonly method: "PUT";
      readonly uploadUrl: string;
      readonly requiredHeaders: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "Published";
      readonly sessionHandle: string;
      readonly mediaId: string;
      readonly sourceAttemptId: string;
      readonly idempotencyOutcome: (typeof UPLOAD_IDEMPOTENCY_OUTCOMES)[number];
    }
  | {
      readonly kind: "NeedsAttention";
      readonly sessionHandle: string;
      readonly failure: UploadFailure;
      readonly capabilities: {
        readonly canRetryUpload: boolean;
        readonly canRemove: boolean;
      };
    };

export type UploadCapability = Extract<
  UploadResponse,
  { kind: "UploadRequired" }
>;
export type PublishedUpload = Extract<UploadResponse, { kind: "Published" }>;

export type UploadFailure =
  | {
      readonly kind: "VerificationFailed";
      readonly code: UploadVerificationCode;
      readonly failedAt: string;
    }
  | {
      readonly kind: "TransportFailed";
      readonly reason: UploadTransportFailure;
      readonly failedAt: string;
    }
  | { readonly kind: "CapabilityExpired"; readonly expiredAt: string };

function uploadFailure(raw: unknown, name: string): UploadFailure {
  const kind = expectString(expectRecord(raw, name).kind, `${name}.kind`);
  if (kind === "VerificationFailed") {
    const failure = expectExactRecord(raw, ["kind", "code", "failed_at"], name);
    return {
      kind,
      code: expectOneOf(failure.code, UPLOAD_VERIFICATION_CODES, `${name}.code`),
      failedAt: expectIsoInstant(failure.failed_at, `${name}.failed_at`),
    };
  }
  if (kind === "TransportFailed") {
    const failure = expectExactRecord(
      raw,
      ["kind", "reason", "failed_at"],
      name,
    );
    return {
      kind,
      reason: decodeUploadTransportFailure(failure.reason, `${name}.reason`),
      failedAt: expectIsoInstant(failure.failed_at, `${name}.failed_at`),
    };
  }
  if (kind === "CapabilityExpired") {
    const failure = expectExactRecord(raw, ["kind", "expired_at"], name);
    return {
      kind,
      expiredAt: expectIsoInstant(failure.expired_at, `${name}.expired_at`),
    };
  }
  throw new TypeError(
    `${name}.kind must be VerificationFailed, TransportFailed, or CapabilityExpired`,
  );
}

// The PUT carries exactly the headers the capability names and the browser may
// set; nexus credentials never reach the storage origin through this record.
function browserSettableHeaders(
  raw: unknown,
  name: string,
): Readonly<Record<string, string>> {
  const headers = expectExactRecord(raw, ["Content-Type"], name);
  return {
    "Content-Type": expectNonemptyString(
      headers["Content-Type"],
      `${name}.Content-Type`,
    ),
  };
}

export function decodeUploadResponse(raw: unknown): UploadResponse {
  const name = "upload response";
  const envelope = expectExactRecord(raw, ["data"], name);
  const data = expectRecord(envelope.data, `${name}.data`);
  const kind = expectString(data.kind, `${name}.kind`);
  if (kind === "UploadRequired") {
    const capability = expectExactRecord(
      data,
      [
        "kind",
        "session_handle",
        "generation",
        "method",
        "upload_url",
        "required_headers",
        "expires_at",
        "idempotency_outcome",
      ],
      name,
    );
    const generation = expectNonnegativeInteger(
      capability.generation,
      `${name}.generation`,
    );
    if (generation < 1) {
      throw new TypeError(`${name}.generation must be positive`);
    }
    expectOneOf(
      capability.idempotency_outcome,
      UPLOAD_IDEMPOTENCY_OUTCOMES,
      `${name}.idempotency_outcome`,
    );
    return {
      kind,
      sessionHandle: expectNonemptyString(
        capability.session_handle,
        `${name}.session_handle`,
      ),
      generation,
      method: expectOneOf(capability.method, ["PUT"] as const, `${name}.method`),
      uploadUrl: expectNonemptyString(
        capability.upload_url,
        `${name}.upload_url`,
      ),
      requiredHeaders: browserSettableHeaders(
        capability.required_headers,
        `${name}.required_headers`,
      ),
      expiresAt: expectIsoInstant(capability.expires_at, `${name}.expires_at`),
    };
  }
  if (kind === "Published") {
    const published = expectExactRecord(
      data,
      [
        "kind",
        "session_handle",
        "media_id",
        "source_attempt_id",
        "idempotency_outcome",
      ],
      name,
    );
    return {
      kind,
      sessionHandle: expectNonemptyString(
        published.session_handle,
        `${name}.session_handle`,
      ),
      mediaId: expectNonemptyString(published.media_id, `${name}.media_id`),
      sourceAttemptId: expectNonemptyString(
        published.source_attempt_id,
        `${name}.source_attempt_id`,
      ),
      idempotencyOutcome: expectOneOf(
        published.idempotency_outcome,
        UPLOAD_IDEMPOTENCY_OUTCOMES,
        `${name}.idempotency_outcome`,
      ),
    };
  }
  if (kind === "NeedsAttention") {
    const attention = expectExactRecord(
      data,
      ["kind", "session_handle", "failure", "capabilities"],
      name,
    );
    const capabilities = expectExactRecord(
      attention.capabilities,
      ["can_retry_upload", "can_remove"],
      `${name}.capabilities`,
    );
    return {
      kind,
      sessionHandle: expectNonemptyString(
        attention.session_handle,
        `${name}.session_handle`,
      ),
      failure: uploadFailure(attention.failure, `${name}.failure`),
      capabilities: {
        canRetryUpload: expectBoolean(
          capabilities.can_retry_upload,
          `${name}.capabilities.can_retry_upload`,
        ),
        canRemove: expectBoolean(
          capabilities.can_remove,
          `${name}.capabilities.can_remove`,
        ),
      },
    };
  }
  throw new TypeError(
    `${name}.kind must be UploadRequired, Published, or NeedsAttention`,
  );
}
