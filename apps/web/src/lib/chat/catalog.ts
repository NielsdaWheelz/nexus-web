import { apiFetch } from "@/lib/api/client";
import type { ReadPolicy } from "@/lib/api/retry";
import type { ApiJson } from "@/lib/api/wire";
import type { Catalog } from "./wire";

// Encloses retries and the response body, with room beyond the server's eight seconds.
export const catalogReadPolicy: ReadPolicy = { timeoutMs: 10_000 };

/** Catalog reads belong to the calling pane or explicit repeat operation. */
export async function readCatalog(signal: AbortSignal | null): Promise<Catalog> {
  const { data } = await apiFetch<ApiJson<"/llm-catalog", "get">>("/api/llm-catalog", {
    cache: "no-store",
    signal,
  });
  return data;
}
