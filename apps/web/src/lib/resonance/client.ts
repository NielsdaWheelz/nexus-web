import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  decodeQuickReadsEnvelope,
  decodeSlateEnvelope,
  slateSnapshotFromWire,
  type SlateSnapshot,
} from "@/lib/resonance/contract";

export async function getQuickReads(signal?: AbortSignal): Promise<SlateSnapshot> {
  return decodeQuickReadsEnvelope(
    await apiFetch<unknown>("/api/lectern/quick-reads", { signal }),
  );
}

export async function getLecternSlate(signal?: AbortSignal): Promise<SlateSnapshot> {
  return decodeSlateEnvelope(
    await apiFetch<unknown>("/api/lectern/slate", { signal }),
  );
}

export async function getLibrarySlate(
  libraryId: string,
  signal?: AbortSignal,
): Promise<SlateSnapshot> {
  const response = await apiFetch<ApiJson<"/libraries/{library_id}/slate", "get">>(
    `/api/libraries/${encodeURIComponent(libraryId)}/slate`,
    { signal },
  );
  return slateSnapshotFromWire(response.data);
}
