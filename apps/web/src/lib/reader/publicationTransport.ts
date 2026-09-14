import { ApiError, apiErrorFromResponse, decodeApiPayload, fetchApiResponse, type ApiPath } from "@/lib/api/client";
import { readBoundedResponseBytes } from "@/lib/api/readBoundedResponseBytes";
import type { ReaderMemberRef } from "./publicationContract";

function readJson(bytes: Uint8Array, response: Response): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(response.status, "E_INVALID_RESPONSE", "Reader response is not valid UTF-8 JSON", response.headers.get("x-request-id") ?? undefined);
  }
}

/** Mutable selected-publication projection; callers own its retry and payload lease. */
export async function readPublicationQuery<T>({ path, body, signal, maxBytes, decode }: {
  readonly path: ApiPath;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  readonly decode: (raw: unknown) => T;
}): Promise<T> {
  const response = await fetchApiResponse(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) throw await apiErrorFromResponse(response);
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(response.status, "E_INVALID_RESPONSE", "Reader query returned an invalid representation", response.headers.get("x-request-id") ?? undefined);
  }
  const bytes = await readBoundedResponseBytes(response, signal, maxBytes);
  return decodeApiPayload(readJson(bytes, response), decode, "Reader publication query");
}

/** One attempt; the shared read owner supplies retry and cancellation. */
export async function readPublicationMember<T>({
  path, signal, maxBytes, expected, generation, decode,
}: {
  readonly path: ApiPath;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  readonly expected?: ReaderMemberRef;
  readonly generation?: number;
  readonly decode: (raw: unknown) => T;
}): Promise<{ readonly data: T; readonly generation: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Reader member byte budget must be configured");
  const response = await fetchApiResponse(path, { signal });
  if (!response.ok) throw await apiErrorFromResponse(response);
  const invalid = (message: string): never => {
    throw new ApiError(response.status, "E_INVALID_RESPONSE", message, response.headers.get("x-request-id") ?? undefined);
  };
  const generationText = response.headers.get("x-nexus-reader-generation");
  const digestText = response.headers.get("content-digest");
  const publishedGeneration = generationText !== null && /^[1-9][0-9]*$/.test(generationText) ? Number(generationText) : NaN;
  const digestMatch = digestText?.match(/^sha-256=:([A-Za-z0-9+/]{43}=):$/);
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" ||
      !Number.isSafeInteger(publishedGeneration) || digestMatch === null || digestMatch === undefined ||
      (generation !== undefined && publishedGeneration !== generation)) {
    await response.body?.cancel().catch(() => undefined);
    return invalid("Reader member representation violates its publication contract");
  }
  const bytes = await readBoundedResponseBytes(response, signal, maxBytes, expected?.bytes);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const declaredDigest = btoa(String.fromCharCode(...digestBytes));
  if (declaredDigest !== digestMatch[1] || (expected !== undefined && expected.sha256 !== digest)) {
    return invalid("Reader member digest does not match its selected publication");
  }
  return { data: decodeApiPayload(readJson(bytes, response), decode, "Reader publication member"), generation: publishedGeneration };
}
