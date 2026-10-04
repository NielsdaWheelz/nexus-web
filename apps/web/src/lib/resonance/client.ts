import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { slateSnapshotFromWire, type SlateSnapshot } from "@/lib/resonance/contract";

export async function getQuickReads(signal?: AbortSignal): Promise<SlateSnapshot> {
  const response = await apiFetch<ApiJson<"/lectern/quick-reads", "get">>(
    "/api/lectern/quick-reads",
    { signal },
  );
  const snapshot = slateSnapshotFromWire(response.data);
  if (snapshot.items.length > 5) {
    throw new Error("Invalid quick reads: at most 5 items");
  }
  for (const item of snapshot.items) {
    if (
      item.target.kind !== "Media" ||
      (item.target.mediaSummary.mediaKind !== "web_article" &&
        item.target.mediaSummary.mediaKind !== "epub" &&
        item.target.mediaSummary.mediaKind !== "pdf") ||
      item.consumption.kind !== "Present" ||
      item.target.mediaSummary.duration.kind !== "Present" ||
      item.target.mediaSummary.duration.value.estimate.remainingMinutes.kind !== "Present" ||
      item.target.mediaSummary.duration.value.estimate.remainingMinutes.value.value <= 0
    ) {
      throw new Error(
        "Invalid quick read: requires a document with consumption and a positive remaining estimate",
      );
    }
  }
  return snapshot;
}

export async function getLecternSlate(signal?: AbortSignal): Promise<SlateSnapshot> {
  const response = await apiFetch<ApiJson<"/lectern/slate", "get">>(
    "/api/lectern/slate",
    { signal },
  );
  return slateSnapshotFromWire(response.data);
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
