// The nexus API adapter the background uses: the `/api/extension` bff paths
// under the build's pinned nexus origin, authorized by the bearer alone
// (cookies omitted), decoded by the shared strict contracts, failing with one
// typed failure. The storage PUT is a separate function that never sees the
// bearer. Source urls are data: nothing here logs, and no message quotes one.

import { isAbortError } from "@/lib/errors";
import {
  decodeWritableLibraryDestinationPage,
  type LibraryDestinationPage,
} from "@/lib/libraries/destinationContract";
import {
  decodeUploadResponse,
  type PublishedUpload,
  type UploadCapability,
  type UploadResponse,
} from "@/lib/media/uploadSessionContract";
import type { UploadTransportFailure } from "@/lib/media/uploadVerification";
import { expectPositiveInteger, expectRecord, isRecord } from "@/lib/validation";
import {
  CaptureFailureError,
  captureFailure,
  captureIntentBody,
  decodeExtensionSession,
  type CaptureIntent,
  type ExtensionSession,
} from "@/extension/captureContract";

// pinned by the build (apps/web/scripts/build-extension.mjs)
declare const __NEXUS_ORIGIN__: string;

const NEXUS_ORIGIN = __NEXUS_ORIGIN__;

/** `RetryUploadSessionRequest`: the same intent, one mutation id per press. */
interface CaptureRetryRequest {
  filename: string;
  content_type: string;
  size_bytes: number;
  client_mutation_id: string;
  expected_generation: number;
}

/** `UploadTransportFailureRequest`: the typed reason plus its generation. */
type CaptureTransportReport = UploadTransportFailure & {
  generation: number;
  duration_ms: number;
  request_id: string;
};

/** Nexus refused to advance: it holds `generation`, not the one expected. */
export interface GenerationConflict {
  kind: "GenerationConflict";
  generation: number;
}

export interface CaptureClient {
  session(signal?: AbortSignal): Promise<ExtensionSession>;
  /** resolves on 204, and on 401: a token nexus no longer honours is revoked */
  revokeSession(signal?: AbortSignal): Promise<void>;
  searchDestinations(q: string, cursor: string | null, signal?: AbortSignal): Promise<LibraryDestinationPage>;
  createCapture(intent: CaptureIntent, operationKey: string, signal?: AbortSignal): Promise<UploadResponse>;
  captureStatus(handle: string, signal?: AbortSignal): Promise<UploadResponse>;
  confirmCapture(handle: string, generation: number, signal?: AbortSignal): Promise<PublishedUpload>;
  /** advances the session one generation, fenced by `expected_generation` */
  retryCapture(
    handle: string,
    request: CaptureRetryRequest,
    signal?: AbortSignal,
  ): Promise<Exclude<UploadResponse, PublishedUpload> | GenerationConflict>;
  reportTransportFailure(handle: string, report: CaptureTransportReport, signal?: AbortSignal): Promise<void>;
  deleteCapture(handle: string, signal?: AbortSignal): Promise<void>;
}

function invalidResponse(detail: string): CaptureFailureError {
  return new CaptureFailureError(
    captureFailure("E_INVALID_RESPONSE", `Nexus answered with an unexpected shape: ${detail}`),
  );
}

async function responseFailure(response: Response): Promise<CaptureFailureError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // a non-JSON error body is reported by its status below
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error !== null && typeof error.code === "string" && typeof error.message === "string") {
    return new CaptureFailureError(
      captureFailure(
        error.code,
        error.message,
        typeof error.request_id === "string" ? error.request_id : null,
      ),
      response.status,
      isRecord(error.details) ? error.details : null,
    );
  }
  return new CaptureFailureError(
    captureFailure("E_UNKNOWN", `Nexus answered HTTP ${response.status}.`),
    response.status,
  );
}

export function isFailureCode(error: unknown, code: string): error is CaptureFailureError {
  return error instanceof CaptureFailureError && error.failure.code === code;
}

export function captureClient(token: string): CaptureClient {
  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${NEXUS_ORIGIN}/api/extension${path}`, {
        method,
        credentials: "omit",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new CaptureFailureError(captureFailure("E_NETWORK", "Nexus could not be reached."));
    }
    if (!response.ok) throw await responseFailure(response);
    return response;
  }

  function strict<T>(decode: () => T): T {
    try {
      return decode();
    } catch (error) {
      throw invalidResponse(error instanceof Error ? error.message : String(error));
    }
  }

  async function decoded<T>(response: Response, decode: (raw: unknown) => T): Promise<T> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw invalidResponse("not JSON");
    }
    return strict(() => decode(raw));
  }

  const captures = (handle: string) => `/captures/${encodeURIComponent(handle)}`;

  return {
    session: async (signal) => decoded(await call("GET", "/session", { signal }), decodeExtensionSession),

    revokeSession: async (signal) => {
      try {
        await call("DELETE", "/session", { signal });
      } catch (error) {
        if (!(error instanceof CaptureFailureError) || error.status !== 401) throw error;
      }
    },

    searchDestinations: async (q, cursor, signal) => {
      const query = new URLSearchParams();
      if (q !== "") query.set("q", q);
      if (cursor !== null) query.set("cursor", cursor);
      const suffix = query.size === 0 ? "" : `?${query}`;
      return decoded(
        await call("GET", `/library-destinations${suffix}`, { signal }),
        decodeWritableLibraryDestinationPage,
      );
    },

    createCapture: async (intent, operationKey, signal) =>
      decoded(
        await call("POST", "/captures", {
          body: captureIntentBody(intent),
          headers: { "Idempotency-Key": operationKey },
          signal,
        }),
        decodeUploadResponse,
      ),

    captureStatus: async (handle, signal) =>
      decoded(await call("GET", captures(handle), { signal }), decodeUploadResponse),

    confirmCapture: async (handle, generation, signal) => {
      const response = await decoded(
        await call("POST", `${captures(handle)}/confirm`, { body: { generation }, signal }),
        decodeUploadResponse,
      );
      if (response.kind !== "Published") throw invalidResponse("confirm must publish");
      return response;
    },

    retryCapture: async (handle, request, signal) => {
      let response: Response;
      try {
        response = await call("POST", `${captures(handle)}/retry`, { body: request, signal });
      } catch (error) {
        if (!isFailureCode(error, "E_RESOURCE_CONFLICT")) throw error;
        const { details } = error;
        return strict(() => ({
          kind: "GenerationConflict",
          generation: expectPositiveInteger(
            expectRecord(details?.current, "conflict.current").generation,
            "conflict.current.generation",
          ),
        }));
      }
      const advanced = await decoded(response, decodeUploadResponse);
      if (advanced.kind === "Published") throw invalidResponse("retry cannot publish");
      return advanced;
    },

    reportTransportFailure: async (handle, report, signal) => {
      await call("POST", `${captures(handle)}/transport-failure`, { body: report, signal });
    },

    deleteCapture: async (handle, signal) => {
      await call("DELETE", captures(handle), { signal });
    },
  };
}

type PutOutcome =
  | { kind: "uploaded" }
  /** the capability closed before a byte moved: not a transport fact */
  | { kind: "expired" }
  | { kind: "failed"; reason: UploadTransportFailure; durationMs: number };

/** PUT the exact bytes to the signed capability with only its required headers,
    bounded by its expiry. No nexus credential accompanies this request. */
export async function putCaptureBytes(
  capability: UploadCapability,
  blob: Blob,
  signal: AbortSignal,
): Promise<PutOutcome> {
  const remainingMs = Date.parse(capability.expiresAt) - Date.now();
  if (remainingMs <= 0) return { kind: "expired" };
  const deadline = AbortSignal.timeout(remainingMs);
  const startedAt = Date.now();
  const durationMs = () => Math.max(0, Date.now() - startedAt);
  let response: Response;
  try {
    response = await fetch(capability.uploadUrl, {
      method: capability.method,
      credentials: "omit",
      headers: capability.requiredHeaders,
      body: blob,
      signal: AbortSignal.any([signal, deadline]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted) return { kind: "failed", reason: { kind: "Timeout" }, durationMs: durationMs() };
    return { kind: "failed", reason: { kind: "Network" }, durationMs: durationMs() };
  }
  if (!response.ok) {
    return {
      kind: "failed",
      reason: { kind: "HttpRejected", status: response.status },
      durationMs: durationMs(),
    };
  }
  return { kind: "uploaded" };
}
