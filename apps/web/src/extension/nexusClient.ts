// The background's nexus adapter: `/api/extension/*` under the build's pinned
// origin, authorized by the bearer alone (cookies omitted), typed by the
// generated wire, failing with one CaptureFailureError. The storage PUT never
// sees the bearer. Source urls are data: nothing here logs one.

import { WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { isAbortError } from "@/lib/errors";
import {
  expectArray,
  expectBoolean,
  expectCanonicalRfcUuid,
  expectExactRecord,
  expectOrderRevision,
  expectInteger,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import { CaptureFailureError, failure } from "@/extension/capture";

declare const __NEXUS_ORIGIN__: string; // pinned by the build

export type UploadAnswer = ApiJson<"/extension/captures", "post">["data"];
export type ExtensionSession = Schema<"ExtensionSessionOut">;
export type CaptureTarget = Schema<"CaptureTargetOut">;

/** This independently installed client accepts only the current guarded wire. */
function destinations(raw: unknown): Schema<"LibraryDestinationsOut"> {
  const value = expectExactRecord(raw, ["removal_revision", "destinations"], "destinations");
  return {
    removal_revision: expectOrderRevision(value.removal_revision),
    destinations: expectArray(value.destinations, raw => {
      const item = expectExactRecord(raw, ["id", "name", "order_revision"], "destination");
      return {
        id: expectCanonicalRfcUuid(item.id, "destination.id"),
        name: expectString(item.name, "destination.name"),
        order_revision: expectOrderRevision(item.order_revision),
      };
    }, "destinations"),
  };
}

function published(raw: unknown): Schema<"Published"> {
  const value = expectExactRecord(raw, ["kind", "import_ref", "session_id", "media_id", "created", "current_placements"], "published capture");
  let current: Schema<"LibraryPlacementsOut"> | null = null;
  if (value.current_placements !== null) {
    const snapshot = expectExactRecord(value.current_placements, ["removal_revision", "all_membership", "placements"], "current placements");
    const all = expectExactRecord(snapshot.all_membership, ["library_id", "order_revision", "included", "remove_blocked"], "all membership");
    current = {
      removal_revision: expectOrderRevision(snapshot.removal_revision),
      all_membership: {
        library_id: expectCanonicalRfcUuid(all.library_id, "all_membership.library_id"),
        order_revision: expectOrderRevision(all.order_revision),
        included: expectBoolean(all.included, "all_membership.included"),
        remove_blocked: all.remove_blocked === null ? null : expectOneOf(all.remove_blocked, ["RequiresAdmin", "PodcastSubscription"], "all_membership.remove_blocked"),
      },
      placements: expectArray(snapshot.placements, raw => {
        const item = expectExactRecord(raw, ["library_id", "name", "order_revision", "relation", "blocked"], "placement");
        return {
          library_id: expectCanonicalRfcUuid(item.library_id, "placement.library_id"),
          name: expectString(item.name, "placement.name"),
          order_revision: expectOrderRevision(item.order_revision),
          relation: expectOneOf(item.relation, ["Absent", "Direct"], "placement.relation"),
          blocked: item.blocked === null ? null : expectOneOf(item.blocked, ["RequiresAdmin", "SystemManaged", "PodcastSubscription"], "placement.blocked"),
        };
      }, "placements"),
    };
  }
  const sessionId = expectCanonicalRfcUuid(value.session_id, "published.session_id");
  const mediaId = expectCanonicalRfcUuid(value.media_id, "published.media_id");
  if (value.import_ref !== `upload:${sessionId}` && value.import_ref !== `media:${mediaId}`) throw new TypeError("published import must name its session or media");
  return {
    kind: expectOneOf(value.kind, ["Published"], "published.kind"),
    import_ref: value.import_ref,
    session_id: sessionId,
    media_id: mediaId,
    created: expectBoolean(value.created, "published.created"),
    current_placements: current,
  };
}

function target(raw: unknown): Schema<"CaptureTarget"> {
  const value = expectExactRecord(raw, ["media_id", "expected_source_attempt_id", "expected_reader_generation"], "capture target");
  const generation = value.expected_reader_generation === null ? null : expectInteger(value.expected_reader_generation, "reader generation");
  if (generation !== null && generation < 1) throw new TypeError("invalid reader generation");
  return { media_id: expectCanonicalRfcUuid(value.media_id, "media id"), expected_source_attempt_id: expectCanonicalRfcUuid(value.expected_source_attempt_id, "source attempt"), expected_reader_generation: generation };
}

function binding(raw: unknown): NonNullable<Schema<"CreateCaptureRequest">["capture_binding"]> {
  const kind = expectOneOf(expectRecord(raw, "binding").kind, ["XArticle", "WebRecovery"], "binding kind");
  if (kind === "XArticle") {
    const value = expectExactRecord(raw, ["kind", "article_id", "target"], "x binding");
    const article_id = expectString(value.article_id, "article id");
    if (!/^[0-9]+$/.test(article_id)) throw new TypeError("invalid article id");
    return { kind, article_id, target: value.target === null ? null : target(value.target) };
  }
  const value = expectExactRecord(raw, ["kind", "target", "source_relation"], "web binding");
  const parsed = target(value.target);
  if (parsed.expected_reader_generation !== null) throw new TypeError("web target has a reader generation");
  return { kind, target: parsed, source_relation: expectOneOf(value.source_relation, ["ExactUrl", "AlternativeCopy"], "source relation") };
}

function summary(raw: unknown): Schema<"TargetSummary"> {
  const value = expectExactRecord(raw, ["title", "source_label", "source_url", "accepted_at"], "target summary");
  return { title: expectString(value.title, "title"), source_label: expectString(value.source_label, "source label"), source_url: expectString(value.source_url, "source url"), accepted_at: expectString(value.accepted_at, "accepted at") };
}

function captureTarget(raw: unknown): CaptureTarget {
  const value = expectExactRecord(raw, ["capture_binding", "target_summary", "web_match"], "capture target response");
  return { capture_binding: value.capture_binding === null ? null : binding(value.capture_binding), target_summary: value.target_summary === null ? null : summary(value.target_summary), web_match: expectOneOf(value.web_match, ["None", "Unique", "Ambiguous"], "web match") };
}

function recoveryPage(raw: unknown): Schema<"RecoveryCandidatePage"> {
  const value = expectExactRecord(raw, ["items", "next_cursor"], "recovery candidates");
  return { items: expectArray(value.items, raw => {
    const item = expectExactRecord(raw, ["binding", "summary"], "recovery candidate");
    const parsed = binding(item.binding);
    if (parsed.kind !== "WebRecovery") throw new TypeError("candidate is not web recovery");
    return { binding: parsed, summary: summary(item.summary) };
  }, "recovery candidates"), next_cursor: value.next_cursor === null ? null : expectString(value.next_cursor, "next cursor") };
}

async function call<T>(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${__NEXUS_ORIGIN__}/api/extension${path}`, {
      method,
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${token}`,
        [WIRE_HEADER]: String(WIRE_REVISION),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw failure("E_NETWORK", "Nexus could not be reached.");
  }
  if (response.status === 426) {
    const message = "Update the Nexus extension to keep capturing.";
    throw failure("E_WIRE_MISMATCH", message, null, 426);
  }
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: unknown; message?: unknown; request_id?: unknown };
  } | null;
  if (response.ok && json !== null) return json.data as T;
  const error = json?.error;
  if (typeof error?.code === "string") {
    const requestId =
      typeof error.request_id === "string" ? error.request_id : null;
    throw failure(
      error.code,
      String(error.message),
      requestId,
      response.status,
    );
  }
  throw failure(
    "E_UNKNOWN",
    `Nexus answered HTTP ${response.status}.`,
    null,
    response.status,
  );
}

export function nexus(token: string) {
  return {
    session: (signal?: AbortSignal) =>
      call<ExtensionSession>(token, "GET", "/session", undefined, signal),
    /** resolves on 204, and on 401: a token nexus no longer honours is revoked */
    revoke: async (signal?: AbortSignal) => {
      try {
        await call<void>(token, "DELETE", "/session", undefined, signal);
      } catch (error) {
        if (!(error instanceof CaptureFailureError && error.status === 401))
          throw error;
      }
    },
    destinations: async (signal?: AbortSignal) =>
      destinations(await call<unknown>(token, "GET", "/library-destinations", undefined, signal)),
    captureTarget: async (sourceUrl: string, signal: AbortSignal) =>
      captureTarget(await call<unknown>(token, "GET", `/capture-target?source_url=${encodeURIComponent(sourceUrl)}`, undefined, signal)),
    recoveryTargets: async (sourceUrl: string, q: string, cursor: string | null) =>
      recoveryPage(await call<unknown>(token, "GET", `/recovery-targets?${new URLSearchParams({ source_url: sourceUrl, q, ...(cursor === null ? {} : { cursor }) })}`)),
    create: async (request: Schema<"CreateCaptureRequest">, signal: AbortSignal) => {
      const answer = await call<UploadAnswer>(token, "POST", "/captures", request, signal);
      return answer.kind === "Published" ? published(answer) : answer;
    },
    confirm: async (id: string, request: Schema<"AcquireCaptureRequest"> | Schema<"RecoverCaptureRequest">, signal: AbortSignal) =>
      published(await call<unknown>(
        token,
        "POST",
        `/captures/${id}/confirm`,
        request,
        signal,
      )),
    remove: (id: string) => call<void>(token, "DELETE", `/captures/${id}`),
  };
}

export type Nexus = ReturnType<typeof nexus>;

/** PUT the exact bytes to the signed url with only its content type, before its
    expiry. No nexus credential goes with it. */
export async function putBytes(
  upload: Schema<"UploadRequired">,
  blob: Blob,
  signal: AbortSignal,
): Promise<void> {
  const remaining = Date.parse(upload.expires_at) - Date.now();
  if (remaining <= 0) {
    throw failure(
      "E_UPLOAD_EXPIRED",
      "The upload window closed. Retry to open a new one.",
    );
  }
  let response: Response;
  try {
    response = await fetch(upload.upload_url, {
      method: "PUT",
      credentials: "omit",
      headers: { "Content-Type": upload.content_type },
      body: blob,
      signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw failure(
      "E_UPLOAD_TRANSPORT",
      "The upload did not complete. Retry to send it again.",
    );
  }
  if (!response.ok) {
    const message = `Storage refused the upload (HTTP ${response.status}). Retry to send it again.`;
    throw failure("E_UPLOAD_TRANSPORT", message);
  }
}
