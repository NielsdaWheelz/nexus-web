import { apiCommand204, apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isRecord } from "@/lib/validation";
import { subscribeToPodcast } from "@/lib/podcasts/acquisition";

export type LibraryPlacementTarget =
  | { kind: "Media"; id: string }
  | { kind: "Podcast"; id: string };

export interface LibraryPlacementOption {
  id: string;
  name: string;
  color: string | null;
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

export class LibraryPlacementContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed owned placement responses are code/schema
    // mismatches. Command status mismatches are guarded by apiCommand204.
    super(message);
    this.name = "LibraryPlacementContractDefect";
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new LibraryPlacementContractDefect(
      `Invalid ${context}: expected exactly [${expected.join(", ")}]`,
    );
  }
}

export function decodeLibraryPlacements(
  raw: unknown,
): LibraryPlacementOption[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new LibraryPlacementContractDefect(
      "Invalid library placements response: expected { data: [...] }",
    );
  }
  requireExactKeys(raw, ["data"], "library placements envelope");
  const placements = raw.data.map((entry) => {
    if (!isRecord(entry)) {
      throw new LibraryPlacementContractDefect(
        "Invalid library placement: expected an object",
      );
    }
    requireExactKeys(
      entry,
      [
        "id",
        "name",
        "color",
        "is_in_library",
        "can_add",
        "can_remove",
      ],
      "library placement",
    );
    const libraryRef =
      typeof entry.id === "string"
        ? parseResourceRef(`library:${entry.id}`)
        : null;
    if (
      libraryRef === null ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      (entry.color !== null && typeof entry.color !== "string") ||
      typeof entry.is_in_library !== "boolean" ||
      typeof entry.can_add !== "boolean" ||
      typeof entry.can_remove !== "boolean" ||
      (entry.is_in_library && entry.can_add) ||
      (!entry.is_in_library && entry.can_remove)
    ) {
      throw new LibraryPlacementContractDefect(
        "Invalid library placement: invalid field",
      );
    }
    return {
      id: libraryRef.id,
      name: entry.name,
      color: entry.color,
      isInLibrary: entry.is_in_library,
      canAdd: entry.can_add,
      canRemove: entry.can_remove,
    };
  });
  if (new Set(placements.map(({ id }) => id)).size !== placements.length) {
    throw new LibraryPlacementContractDefect(
      "Invalid library placements response: duplicate library id",
    );
  }
  return placements;
}

function listPath(target: LibraryPlacementTarget) {
  switch (target.kind) {
    case "Media":
      return `/api/media/${target.id}/libraries` as const;
    case "Podcast":
      return `/api/podcasts/${target.id}/libraries` as const;
  }
}

export async function listLibraryPlacements(
  target: LibraryPlacementTarget,
  { signal }: { signal?: AbortSignal } = {},
): Promise<LibraryPlacementOption[]> {
  return decodeLibraryPlacements(
    await apiFetch<unknown>(listPath(target), { signal }),
  );
}

export async function addLibraryPlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  { clientMutationId }: { clientMutationId: string },
): Promise<void> {
  switch (target.kind) {
    case "Media":
      await addMediaToLibraries(target.id, [libraryId]);
      return;
    case "Podcast":
      await subscribeToPodcast({
        target: { kind: "Canonical", podcastId: target.id },
        namedLibraryIds: [libraryId],
        replacementConfirmation: { kind: "Absent" },
        idempotencyKey: clientMutationId,
      });
      return;
  }
}

export async function removeLibraryPlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  {
    clientMutationId,
    signal,
  }: { clientMutationId: string; signal?: AbortSignal },
): Promise<CollectionRevision> {
  let response: unknown;
  switch (target.kind) {
    case "Media":
      response = await apiFetch<unknown>(
        `/api/media/${target.id}/libraries/${libraryId}`,
        {
        method: "DELETE",
        signal,
        },
      );
      break;
    case "Podcast":
      response = await apiFetch<unknown>(
        `/api/libraries/${libraryId}/podcasts/${target.id}`,
        {
          method: "DELETE",
          headers: { "Idempotency-Key": clientMutationId },
          signal,
        },
      );
      break;
  }
  if (!isRecord(response)) {
    throw new LibraryPlacementContractDefect(
      "Invalid LibraryEntryRemovalOut envelope",
    );
  }
  requireExactKeys(response, ["data"], "LibraryEntryRemovalOut envelope");
  if (!isRecord(response.data)) {
    throw new LibraryPlacementContractDefect(
      "Invalid LibraryEntryRemovalOut.data",
    );
  }
  requireExactKeys(
    response.data,
    target.kind === "Podcast"
      ? ["outcome", "libraryEntriesCollectionRevision"]
      : ["libraryEntriesCollectionRevision"],
    "Library placement removal data",
  );
  if (target.kind === "Podcast") {
    const outcome = response.data.outcome;
    if (outcome !== "Removed" && outcome !== "AlreadyAbsent") {
      throw new LibraryPlacementContractDefect(
        "Invalid PodcastPlacementRemovalOut outcome",
      );
    }
  }
  const revision = decodeCollectionRevision(
    response.data.libraryEntriesCollectionRevision,
  );
  publishLibraryPlacementChange([libraryId]);
  return revision;
}

export async function addMediaToLibraries(
  mediaId: string,
  libraryIds: readonly string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  await apiCommand204(`/api/media/${mediaId}/libraries`, {
    method: "POST",
    body: JSON.stringify({ library_ids: libraryIds }),
    signal,
  });
  publishLibraryPlacementChange([...libraryIds]);
}

// Add Content already owns an authorized intake session and patches its local
// multi-item projection. The resource-action overlay never uses this helper.
export function patchLibraryPlacement<T extends LibraryPlacementOption>(
  libraries: readonly T[],
  libraryId: string,
  isInLibrary: boolean,
): T[] {
  return libraries.map((library) =>
    library.id === libraryId
      ? {
          ...library,
          isInLibrary,
          canAdd: !isInLibrary,
          canRemove: isInLibrary,
        }
      : library,
  );
}
