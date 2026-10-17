import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { Catalog } from "./wire";

/** Catalog reads belong to the calling pane or explicit repeat operation. */
export async function readCatalog(signal: AbortSignal | null): Promise<Catalog> {
  const { data } = await apiFetch<ApiJson<"/llm-catalog", "get">>("/api/llm-catalog", {
    cache: "no-store",
    signal,
  });
  return data;
}
