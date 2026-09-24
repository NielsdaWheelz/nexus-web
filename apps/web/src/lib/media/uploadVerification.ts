// The upload vocabularies both browser upload modules speak: the closed set of
// terminal verification rejections, and the closed transport-failure union the
// browser reports and history replays. Confirmation records exactly these
// verification codes on a session, and both decoders narrow to these unions so a
// server that adds a fourth variant fails the strict decode instead of rendering
// the wrong reason.

import {
  expectExactRecord,
  expectNonnegativeInteger,
  expectOneOf,
  expectRecord,
} from "@/lib/validation";

export const UPLOAD_VERIFICATION_CODES = [
  "E_SOURCE_INTEGRITY",
  "E_INVALID_FILE_TYPE",
  "E_FILE_TOO_LARGE",
  "E_CAPTURE_TOO_LARGE",
] as const;

export type UploadVerificationCode = (typeof UPLOAD_VERIFICATION_CODES)[number];

/** The `UploadTransportFailure` union of `python/nexus/schemas/upload_failures.py`. */
export type UploadTransportFailure =
  | { readonly kind: "Network" | "Timeout" | "Aborted" }
  | { readonly kind: "HttpRejected"; readonly status: number };

export function decodeUploadTransportFailure(
  raw: unknown,
  name: string,
): UploadTransportFailure {
  const kind = expectOneOf(
    expectRecord(raw, name).kind,
    ["Network", "Timeout", "Aborted", "HttpRejected"] as const,
    `${name}.kind`,
  );
  if (kind === "HttpRejected") {
    const failure = expectExactRecord(raw, ["kind", "status"], name);
    const status = expectNonnegativeInteger(failure.status, `${name}.status`);
    if (status < 100 || status > 599) {
      throw new TypeError(`${name}.status must be an HTTP status`);
    }
    return { kind, status };
  }
  expectExactRecord(raw, ["kind"], name);
  return { kind };
}
