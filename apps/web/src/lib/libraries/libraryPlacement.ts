import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { LibraryContractDefect } from "@/lib/libraries/contract";

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

export type PlacementCommand =
  | Schema<"MediaLibraryPlacementCommand">
  | Schema<"PodcastLibraryPlacementCommand">;
export type PlacementReceipt = Schema<"LibraryPlacementCommandOut">;
export type PlacementRefusalCode = Extract<PlacementReceipt["outcome"], { kind: "Refused" }>["code"];

const PLACEMENT_REFUSAL_CODES = {
  E_MEDIA_NOT_FOUND: true,
  E_NOT_FOUND: true,
  E_LIBRARY_NOT_FOUND: true,
  E_FORBIDDEN: true,
  E_LIBRARY_FORBIDDEN: true,
  E_DEFAULT_LIBRARY_FORBIDDEN: true,
  E_INVALID_REQUEST: true,
  E_MEDIA_DELETING: true,
  E_MEDIA_LAST_REFERENCE: true,
  E_PODCAST_SUBSCRIPTION_REQUIRED: true,
  E_PODCAST_REPLACES_EPISODES: true,
} satisfies Record<PlacementRefusalCode, true>;

/** The owner supplies one fetch/body deadline and settles the durable journal before successors. */
export async function sendLibraryPlacementCommand(
  command: PlacementCommand,
  { signal }: { signal?: AbortSignal } = {},
): Promise<PlacementReceipt> {
  const { data } = await apiFetch<ApiJson<"/library-placement-commands", "post">>(
    "/api/library-placement-commands",
    { method: "POST", body: JSON.stringify(command), signal },
  );
  if (data?.clientMutationId !== command.clientMutationId) {
    throw new LibraryContractDefect("Library placement receipt does not match its command identity.");
  }
  const outcome = data.outcome;
  // This terminal result authorizes durable journal retirement. An unknown
  // outcome must retain the sent identity even when the reply id matches.
  if (outcome?.kind !== "Confirmed" && (outcome?.kind !== "Refused"
    || typeof outcome.code !== "string" || !Object.hasOwn(PLACEMENT_REFUSAL_CODES, outcome.code))) {
    throw new LibraryContractDefect("Library placement receipt has no recognized terminal outcome.");
  }
  return data;
}
