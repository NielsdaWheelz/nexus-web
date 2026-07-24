import { apiCommand204, apiFetch } from "@/lib/api/client";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isRecord } from "@/lib/validation";

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
): Promise<void> {
  switch (target.kind) {
    case "Media":
      await addMediaToLibraries(target.id, [libraryId]);
      return;
    case "Podcast":
      await apiCommand204(`/api/libraries/${libraryId}/podcasts`, {
        method: "POST",
        body: JSON.stringify({ podcast_id: target.id }),
      });
      return;
  }
}

export async function removeLibraryPlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  switch (target.kind) {
    case "Media":
      await apiCommand204(`/api/media/${target.id}/libraries/${libraryId}`, {
        method: "DELETE",
        signal,
      });
      return;
    case "Podcast":
      await apiCommand204(
        `/api/libraries/${libraryId}/podcasts/${target.id}`,
        { method: "DELETE", signal },
      );
      return;
  }
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
