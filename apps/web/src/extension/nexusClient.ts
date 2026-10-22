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
  expectOneOf,
  expectString,
} from "@/lib/validation";
import { CaptureFailureError, failure } from "@/extension/capture";

declare const __NEXUS_ORIGIN__: string; // pinned by the build

export type UploadAnswer = ApiJson<"/extension/captures", "post">["data"];
export type ExtensionSession = Schema<"ExtensionSessionOut">;
export type CaptureTarget = Schema<"CaptureTargetOut">;

function revision(raw: unknown): string {
  const value = expectString(raw, "revision");
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > BigInt("9223372036854775807")) {
    throw new TypeError("revision must be an exact positive bigint decimal string");
  }
  return value;
}

/** This independently installed client accepts only the current guarded wire. */
function destinations(raw: unknown): Schema<"LibraryDestinationsOut"> {
  const value = expectExactRecord(raw, ["removal_revision", "destinations"], "destinations");
  return {
    removal_revision: revision(value.removal_revision),
    destinations: expectArray(value.destinations, raw => {
      const item = expectExactRecord(raw, ["id", "name", "order_revision"], "destination");
      return {
        id: expectCanonicalRfcUuid(item.id, "destination.id"),
        name: expectString(item.name, "destination.name"),
        order_revision: revision(item.order_revision),
      };
    }, "destinations"),
  };
}

function published(raw: unknown): Schema<"Published"> {
  const value = expectExactRecord(raw, ["kind", "import_ref", "session_id", "media_id", "created", "current_placements"], "published capture");
  let current: Schema<"LibraryPlacementsOut"> | null = null;
  if (value.current_placements !== null) {
    const snapshot = expectExactRecord(value.current_placements, ["removal_revision", "placements"], "current placements");
    current = {
      removal_revision: revision(snapshot.removal_revision),
      placements: expectArray(snapshot.placements, raw => {
        const item = expectExactRecord(raw, ["library_id", "name", "order_revision", "relation", "blocked"], "placement");
        return {
          library_id: expectCanonicalRfcUuid(item.library_id, "placement.library_id"),
          name: expectString(item.name, "placement.name"),
          order_revision: revision(item.order_revision),
          relation: expectOneOf(item.relation, ["Absent", "Direct", "Inherited"], "placement.relation"),
          blocked: item.blocked === null ? null : expectOneOf(item.blocked, ["RequiresAdmin", "RequiresSubscription", "SystemManaged"], "placement.blocked"),
        };
      }, "placements"),
    };
  }
  const sessionId = expectCanonicalRfcUuid(value.session_id, "published.session_id");
  if (value.import_ref !== `upload:${sessionId}`) throw new TypeError("published import must name its session");
  return {
    kind: expectOneOf(value.kind, ["Published"], "published.kind"),
    import_ref: `upload:${sessionId}`,
    session_id: sessionId,
    media_id: expectCanonicalRfcUuid(value.media_id, "published.media_id"),
    created: expectBoolean(value.created, "published.created"),
    current_placements: current,
  };
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
    captureTarget: (sourceUrl: string, signal: AbortSignal) =>
      call<CaptureTarget>(token, "GET", `/capture-target?source_url=${encodeURIComponent(sourceUrl)}`, undefined, signal),
    create: async (request: Schema<"CreateCaptureRequest">, signal: AbortSignal) => {
      const answer = await call<UploadAnswer>(token, "POST", "/captures", request, signal);
      return answer.kind === "Published" ? published(answer) : answer;
    },
    confirm: async (id: string, request: Schema<"ConfirmUploadRequest">, signal: AbortSignal) =>
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
