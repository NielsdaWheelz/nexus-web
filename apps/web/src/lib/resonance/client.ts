import { apiFetch } from "@/lib/api/client";
import { decodeSlateEnvelope, type SlateSnapshot } from "@/lib/resonance/contract";

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
