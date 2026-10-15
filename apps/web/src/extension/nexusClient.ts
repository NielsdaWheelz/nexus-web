// The background's nexus adapter: `/api/extension/*` under the build's pinned
// origin, authorized by the bearer alone (cookies omitted), typed by the
// generated wire, failing with one CaptureFailureError. The storage PUT never
// sees the bearer. Source urls are data: nothing here logs one.

import { WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { isAbortError } from "@/lib/errors";
import { CaptureFailureError, failure } from "@/extension/capture";

declare const __NEXUS_ORIGIN__: string; // pinned by the build

export type UploadAnswer = ApiJson<"/extension/captures", "post">["data"];
export type ExtensionSession = Schema<"ExtensionSessionOut">;
type DestinationPage = ApiJson<
  "/extension/library-destinations",
  "get"
>["data"];

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
    destinations: (q: string, cursor: string | null) => {
      const query = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const path = `/library-destinations${query.size ? `?${query}` : ""}`;
      return call<DestinationPage>(token, "GET", path);
    },
    create: (request: Schema<"CreateCaptureRequest">, signal: AbortSignal) =>
      call<UploadAnswer>(token, "POST", "/captures", request, signal),
    confirm: (id: string, generation: number, signal: AbortSignal) =>
      call<Schema<"Published">>(
        token,
        "POST",
        `/captures/${id}/confirm`,
        { generation },
        signal,
      ),
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
