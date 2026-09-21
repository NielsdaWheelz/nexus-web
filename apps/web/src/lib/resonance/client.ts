import { apiFetch } from "@/lib/api/client";
import {
  decodeQuickReadsEnvelope,
  decodeSlateEnvelope,
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
  return decodeSlateEnvelope(
    await apiFetch<unknown>(`/api/libraries/${encodeURIComponent(libraryId)}/slate`, {
      signal,
    }),
  );
}
