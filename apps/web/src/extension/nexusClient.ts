// The installed extension's guarded bearer boundary. Decode only the summary
// projection the receipt consumes; never pass an unchecked server value onward.
// Signed storage PUTs carry no nexus credential.
import { WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { Schema } from "@/lib/api/wire";
import { IMPORT_WORDS } from "@/lib/imports/words";
import { isAbortError } from "@/lib/errors";
import { CONTRIBUTOR_ROLES } from "@/lib/contributors/credits";
import {
  expectArray, expectBoolean, expectCanonicalRfcUuid, expectExactRecord,
  expectOrderRevision, expectInteger, expectOneOf, expectRecord, expectString,
  expectNullableString, expectPositiveInteger, expectIsoInstant,
} from "@/lib/validation";
import { CaptureFailureError, failure, type ExtensionItem, type SaveTarget } from "@/extension/capture";

declare const __NEXUS_ORIGIN__: string;
export type ExtensionSession = Schema<"ExtensionSessionOut">;
export type UploadAnswer = Schema<"UploadRequired"> | Schema<"Published"> | Schema<"Rejected">;
const uuid = (raw: unknown) => expectCanonicalRfcUuid(raw, "id");
const str = (raw: unknown) => expectString(raw, "text");
const nullable = (raw: unknown) => expectNullableString(raw, "text");
const bool = (raw: unknown) => expectBoolean(raw, "boolean");

function placement(raw: unknown): Schema<"LibraryPlacementOut"> {
  const v = expectExactRecord(raw, ["library_id", "name", "order_revision", "relation", "blocked"], "placement");
  return { library_id: uuid(v.library_id), name: str(v.name), order_revision: expectOrderRevision(v.order_revision),
    relation: expectOneOf(v.relation, ["Absent", "Direct"], "relation"),
    blocked: v.blocked === null ? null : expectOneOf(v.blocked, ["RequiresAdmin", "SystemManaged", "FeedSubscription"], "blocked") };
}
function placements(raw: unknown): Schema<"LibraryPlacementsOut"> {
  const v = expectExactRecord(raw, ["removal_revision", "all_membership", "placements"], "placements");
  const all = expectExactRecord(v.all_membership, ["library_id", "order_revision", "included", "retained", "remove_blocked"], "all membership");
  return { removal_revision: expectOrderRevision(v.removal_revision), placements: expectArray(v.placements, placement, "placements"),
    all_membership: { library_id: uuid(all.library_id), order_revision: expectOrderRevision(all.order_revision),
      included: bool(all.included), retained: bool(all.retained),
      remove_blocked: all.remove_blocked === null ? null : expectOneOf(all.remove_blocked, ["RequiresAdmin", "FeedSubscription"], "remove blocked") } };
}
function contributor(raw: unknown): Schema<"ContributorCreditOut"> {
  const v = expectExactRecord(raw, ["contributor_display_name", "contributor_handle", "credited_name", "href", "ordinal", "raw_role", "role"], "credit");
  const role = str(v.role);
  function isRole(value: string): value is Schema<"ContributorCreditOut">["role"] { return CONTRIBUTOR_ROLES.has(value); }
  if (!isRole(role)) throw new TypeError("invalid contributor role");
  return { contributor_display_name: nullable(v.contributor_display_name), contributor_handle: nullable(v.contributor_handle),
    credited_name: str(v.credited_name), href: nullable(v.href), ordinal: v.ordinal === null ? null : expectInteger(v.ordinal, "ordinal"),
    raw_role: nullable(v.raw_role), role };
}
function item(raw: unknown): ExtensionItem {
  const v = expectExactRecord(raw, ["summary", "has_readable_copy", "source_attempt", "placements", "acquisition_revision"], "item");
  const s = expectExactRecord(v.summary, ["can_play", "consumption", "contributors", "duration", "media_id", "media_kind", "original_published_date", "part_source", "processing_status", "show", "title", "x_article_content"], "summary");
  let attempt: ExtensionItem["source_attempt"] = null;
  if (v.source_attempt !== null) {
    const a = expectExactRecord(v.source_attempt, ["id", "status", "error_code"], "source attempt");
    attempt = { id: uuid(a.id), status: expectOneOf(a.status, ["accepted", "queued", "running", "succeeded", "failed"], "source status"), error_code: nullable(a.error_code) };
  }
  return { summary: { media_id: uuid(s.media_id), title: str(s.title), contributors: expectArray(s.contributors, contributor, "credits"),
    processing_status: expectOneOf(s.processing_status, ["pending", "extracting", "ready_for_reading", "failed", "suspended"], "processing status") },
    has_readable_copy: bool(v.has_readable_copy), source_attempt: attempt, placements: placements(v.placements), acquisition_revision: expectOrderRevision(v.acquisition_revision) };
}
function target(raw: unknown): Schema<"SourceTarget"> {
  const v = expectExactRecord(raw, ["media_id", "expected_source_attempt_id"], "target");
  return { media_id: uuid(v.media_id), expected_source_attempt_id: v.expected_source_attempt_id === null ? null : uuid(v.expected_source_attempt_id) };
}
function decimal(raw: unknown): string {
  const value = str(raw);
  if (!/^[0-9]+$/u.test(value)) throw new TypeError("invalid provider id");
  return value;
}
function saveTarget(raw: unknown): SaveTarget {
  const v = expectExactRecord(raw, ["source", "target", "item", "expected_removal_revision"], "save target");
  const kind = expectOneOf(expectRecord(v.source, "source").kind, ["Browser", "XStatus"], "source kind");
  let source: SaveTarget["source"];
  if (kind === "Browser") {
    const s = expectExactRecord(v.source, ["kind", "x_article_id"], "browser source");
    source = { kind, x_article_id: s.x_article_id === null ? null : decimal(s.x_article_id) };
  } else {
    const s = expectExactRecord(v.source, ["kind", "revision_id"], "x source");
    source = { kind, revision_id: decimal(s.revision_id) };
  }
  const resolved = v.target === null ? null : target(v.target);
  const current = v.item === null ? null : item(v.item);
  if ((resolved === null) !== (current === null) || resolved !== null && resolved.media_id !== current?.summary.media_id) throw new TypeError("target and item disagree");
  return { source, target: resolved, item: current, expected_removal_revision: expectOrderRevision(v.expected_removal_revision) };
}
function published(raw: unknown): Schema<"Published"> {
  const v = expectExactRecord(raw, ["kind", "import_ref", "session_id", "media_id", "source_attempt_id", "created", "current_placements"], "published");
  return { kind: expectOneOf(v.kind, ["Published"], "published"), import_ref: str(v.import_ref), session_id: uuid(v.session_id),
    media_id: uuid(v.media_id), source_attempt_id: uuid(v.source_attempt_id), created: bool(v.created),
    current_placements: v.current_placements === null ? null : placements(v.current_placements) };
}
function upload(raw: unknown): UploadAnswer {
  const kind = expectOneOf(expectRecord(raw, "upload").kind, ["Published", "Rejected", "UploadRequired"], "upload kind");
  if (kind === "Published") return published(raw);
  if (kind === "Rejected") {
    const v = expectExactRecord(raw, ["kind", "code", "import_ref", "session_id"], "rejected");
    return { kind, code: expectOneOf(v.code, ["E_SOURCE_INTEGRITY", "E_INVALID_FILE_TYPE", "E_FILE_TOO_LARGE", "E_CAPTURE_TOO_LARGE"], "rejection"), import_ref: str(v.import_ref), session_id: uuid(v.session_id) };
  }
  const v = expectExactRecord(raw, ["kind", "import_ref", "session_id", "generation", "upload_url", "content_type", "expires_at"], "upload required");
  return { kind, import_ref: str(v.import_ref), session_id: uuid(v.session_id), generation: expectPositiveInteger(v.generation, "generation"),
    upload_url: str(v.upload_url), content_type: str(v.content_type), expires_at: expectIsoInstant(v.expires_at, "upload expiry") };
}
function sourceAttempt(raw: unknown): Schema<"SourceAttemptOut"> {
  const v = expectExactRecord(raw, ["source_attempt_id", "media_id", "import_ref", "settled"], "source attempt");
  return { source_attempt_id: uuid(v.source_attempt_id), media_id: uuid(v.media_id), import_ref: str(v.import_ref), settled: bool(v.settled) };
}
function fromUrl(raw: unknown): Schema<"FromUrlOut"> {
  const v = expectExactRecord(raw, ["source_attempt_id", "media_id", "import_ref", "created", "processing_status"], "source admission");
  return { source_attempt_id: uuid(v.source_attempt_id), media_id: uuid(v.media_id), import_ref: str(v.import_ref), created: bool(v.created),
    processing_status: expectOneOf(v.processing_status, ["pending", "extracting", "ready_for_reading", "failed"], "processing status") };
}
function session(raw: unknown): ExtensionSession {
  const v = expectExactRecord(raw, ["user_id", "email", "display_name", "limits"], "session");
  const l = expectExactRecord(v.limits, ["max_pdf_bytes", "max_epub_bytes", "max_article_packet_bytes"], "capture limits");
  return { user_id: uuid(v.user_id), email: nullable(v.email), display_name: nullable(v.display_name), limits: {
    max_pdf_bytes: expectPositiveInteger(l.max_pdf_bytes, "pdf limit"), max_epub_bytes: expectPositiveInteger(l.max_epub_bytes, "epub limit"),
    max_article_packet_bytes: expectPositiveInteger(l.max_article_packet_bytes, "article limit") } };
}
function removalPreview(raw: unknown): Schema<"MediaRemovalPreviewOut"> {
  const v = expectExactRecord(raw, ["media_id", "title", "acquisition_revision"], "removal preview");
  return { media_id: uuid(v.media_id), title: str(v.title), acquisition_revision: expectOrderRevision(v.acquisition_revision) };
}

/** justify-defect: these codes name broken same-system invariants, not refusals. */
export function isCaptureDefect(code: string): boolean {
  return ["E_INTERNAL", "E_UNKNOWN", "E_INVALID_RESPONSE", "E_CAPTURE_DEFECT", "E_CAPTURE_CONTENT"].includes(code);
}
async function call(token: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string,
  body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${__NEXUS_ORIGIN__}/api/extension${path}`, { method, credentials: "omit",
      headers: { Authorization: `Bearer ${token}`, [WIRE_HEADER]: String(WIRE_REVISION), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw failure("E_NETWORK", navigator.onLine === false ? "you’re offline." : "nexus isn’t answering.", null, null, navigator.onLine === false);
  }
  if (response.status === 426) throw failure("E_WIRE_MISMATCH", "nexus updated. update this extension to keep saving.", null, 426);
  if (response.status === 204) return null;
  const json: unknown = await response.json().catch(() => null);
  const envelope = expectRecord(json, "response");
  if (response.ok) return envelope.data;
  const error = expectRecord(envelope.error, "error");
  const code = str(error.code);
  const requestId = typeof error.request_id === "string" ? error.request_id : null;
  if (isCaptureDefect(code)) {
    console.error("extension server defect:", { status: response.status, error });
    throw failure(code, "the extension stopped unexpectedly.", requestId, response.status);
  }
  throw failure(code, refusal(code, response.status), requestId, response.status);
}
/** Fixed reasons from these routes, never the server's own message. */
function refusal(code: string, status: number): string {
  if (status === 401) return "sign in to continue.";
  if (code === "E_DATABASE_BUSY" || code === "E_RATE_LIMITED" || code === "E_AUTH_UNAVAILABLE") return "nexus is busy.";
  switch (code) {
    case "E_SOURCE_TARGET_AMBIGUOUS": return "more than one saved item matches this source.";
    case "E_RESOURCE_CONFLICT":
    case "E_CAPTURE_TARGET_CHANGED": return "this item changed. make a new choice.";
    case "E_MEDIA_DELETING": return `${IMPORT_WORDS.deleting}.`;
    case "E_INVALID_REQUEST": return `${IMPORT_WORDS.refused}.`;
    case "E_FILE_TOO_LARGE": return `${IMPORT_WORDS.tooBig}.`;
    case "E_INVALID_FILE_TYPE": return "nexus refused what arrived.";
    case "E_SOURCE_INTEGRITY": return `${IMPORT_WORDS.integrity}.`;
    case "E_CAPTURE_TOO_LARGE": return "this page is too large to save.";
    case "E_LIBRARY_NOT_FOUND": return "this library is no longer available.";
    case "E_LIBRARY_FORBIDDEN": return "you can’t change this library.";
    case "E_UPLOAD_CAPABILITY_EXPIRED": return `${IMPORT_WORDS.timedOut}.`;
    case "E_SIGN_UPLOAD_FAILED": return `${IMPORT_WORDS.notPrepared}.`;
    case "E_STORAGE_ERROR": return `${IMPORT_WORDS.notChecked}.`;
    case "E_STORAGE_MISSING": return `${IMPORT_WORDS.stopped}.`;
    case "E_UPLOAD_SESSION_NOT_FOUND": return "removed since.";
    case "E_UPLOAD_GENERATION_STALE": return "this upload was replaced.";
    case "E_UNAUTHENTICATED": return "sign in to continue.";
  }
  return status >= 500 ? "nexus isn’t answering." : `${IMPORT_WORDS.refused}.`;
}
export function nexus(token: string) {
  return {
    session: async (signal?: AbortSignal) => session(await call(token, "GET", "/session", undefined, signal)),
    revoke: async (signal: AbortSignal) => {
      try { await call(token, "DELETE", "/session", undefined, signal); }
      catch (error) { if (!(error instanceof CaptureFailureError && error.status === 401)) throw error; }
    },
    saveTarget: async (url: string, signal: AbortSignal) => saveTarget(await call(token, "GET", `/save-target?source_url=${encodeURIComponent(url)}`, undefined, signal)),
    source: async (request: Schema<"CreateExtensionSourceRequest">, signal: AbortSignal) => fromUrl(await call(token, "POST", "/sources", request, signal)),
    sourceAttempt: async (id: string, signal: AbortSignal) => sourceAttempt(await call(token, "GET", `/sources/${id}`, undefined, signal)),
    item: async (id: string, signal: AbortSignal) => item(await call(token, "GET", `/items/${id}`, undefined, signal)),
    create: async (request: Schema<"CreateCaptureRequest">, signal: AbortSignal) => upload(await call(token, "POST", "/captures", request, signal)),
    confirm: async (id: string, request: Schema<"ConfirmCaptureRequest">, signal: AbortSignal) => published(await call(token, "POST", `/captures/${id}/confirm`, request, signal)),
    place: async (libraryId: string, mediaId: string, request: Schema<"PlaceItemRequest">, signal: AbortSignal) => placement(await call(token, "PUT", `/libraries/${libraryId}/items/${encodeURIComponent(`media:${mediaId}`)}`, request, signal)),
    removalPreview: async (id: string, signal: AbortSignal) => removalPreview(await call(token, "GET", `/items/${id}/removal-preview`, undefined, signal)),
    removeItem: async (id: string, request: Schema<"RemoveMediaRequest">, signal: AbortSignal) => { await call(token, "DELETE", `/items/${id}`, request, signal); },
  };
}
export type Nexus = ReturnType<typeof nexus>;

/** Upload exactly the frozen bytes; expired capabilities require the same create. */
export async function putBytes(upload: Schema<"UploadRequired">, blob: Blob, signal: AbortSignal): Promise<void> {
  const remaining = Date.parse(upload.expires_at) - Date.now();
  if (remaining <= 0) throw failure("E_UPLOAD_EXPIRED", `${IMPORT_WORDS.timedOut}.`);
  let response: Response;
  try { response = await fetch(upload.upload_url, { method: "PUT", credentials: "omit", headers: { "Content-Type": upload.content_type },
    body: blob, signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]) }); }
  catch { throw failure("E_UPLOAD_TRANSPORT", `${IMPORT_WORDS.stopped}.`); }
  if (!response.ok) throw failure("E_UPLOAD_TRANSPORT", `${IMPORT_WORDS.stopped}.`);
}
