import { apiCommand204, apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";

export type LibraryPlacementTarget =
  | { readonly kind: "Media"; readonly id: string }
  | { readonly kind: "Podcast"; readonly id: string };

export type LibraryPlacementOption = Schema<"LibraryPlacementOptionOut">;
export type LibraryPlacementDestination = LibraryPlacementOption["destination"];
export type LibraryPlacementBlockedReason =
  Schema<"BlockedLibraryPlacementAvailabilityOut">["reason"];
export type LibraryPlacementDestinationKey = "SavedInNexus" | `Library:${string}`;

export function libraryPlacementDestinationKey(
  destination: LibraryPlacementDestination,
): LibraryPlacementDestinationKey {
  return destination.kind === "SavedInNexus" ? "SavedInNexus" : `Library:${destination.library.id}`;
}

/** The target's whole placement inventory, in server order. */
export async function listLibraryPlacements(
  target: LibraryPlacementTarget,
  { signal }: { signal?: AbortSignal } = {},
): Promise<LibraryPlacementOption[]> {
  const response =
    target.kind === "Media"
      ? await apiFetch<ApiJson<"/media/{media_id}/libraries", "get">>(
          `/api/media/${target.id}/libraries`,
          { signal },
        )
      : await apiFetch<ApiJson<"/podcasts/{podcast_id}/libraries", "get">>(
          `/api/podcasts/${target.id}/libraries`,
          { signal },
        );
  return response.data;
}

interface PlacementWrite {
  readonly target: LibraryPlacementTarget;
  readonly destination: LibraryPlacementDestination;
  readonly signal?: AbortSignal;
}

// Every placement write is idempotent, so a write that failed in transport is
// retried by resending it. A write publishes the library it changed once it
// succeeds. Saved in Nexus is the viewer's default library, whose id no open
// pane holds, so it publishes "Unknown".

export async function addLibraryPlacement({
  target,
  destination,
  signal,
}: PlacementWrite): Promise<void> {
  if (destination.kind === "SavedInNexus") {
    await apiCommand204(`/api/media/${target.id}/saved-in-nexus`, { method: "PUT", signal });
    publishLibraryPlacementChange("Unknown");
    return;
  }
  const libraryId = destination.library.id;
  if (target.kind === "Media") {
    await apiCommand204(`/api/media/${target.id}/libraries`, {
      method: "POST",
      body: JSON.stringify({ library_ids: [libraryId] }),
      signal,
    });
  } else {
    await apiFetch(`/api/libraries/${libraryId}/podcasts/${target.id}`, { method: "PUT", signal });
  }
  publishLibraryPlacementChange([libraryId]);
}

export async function removeLibraryPlacement({
  target,
  destination,
  signal,
}: PlacementWrite): Promise<void> {
  if (destination.kind === "SavedInNexus") {
    await apiFetch(`/api/media/${target.id}/saved-in-nexus`, { method: "DELETE", signal });
    publishLibraryPlacementChange("Unknown");
    return;
  }
  const libraryId = destination.library.id;
  await apiFetch(
    target.kind === "Media"
      ? `/api/media/${target.id}/libraries/${libraryId}`
      : `/api/libraries/${libraryId}/podcasts/${target.id}`,
    { method: "DELETE", signal },
  );
  publishLibraryPlacementChange([libraryId]);
}

/** Add Content patches its local copy of an inventory after a confirmed write. */
export function projectLibraryPlacement(
  placements: readonly LibraryPlacementOption[],
  destination: LibraryPlacementDestination,
  relation: Extract<LibraryPlacementOption["relation"], { kind: "Absent" | "Direct" }>,
): LibraryPlacementOption[] {
  const key = libraryPlacementDestinationKey(destination);
  return placements.map((placement) =>
    libraryPlacementDestinationKey(placement.destination) === key
      ? { ...placement, relation }
      : placement,
  );
}
