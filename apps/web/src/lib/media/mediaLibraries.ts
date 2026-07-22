import { apiCommand204, apiFetch } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";

export interface LibraryTargetPickerItem {
  id: string;
  name: string;
  color: string | null;
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

export class MediaLibraryContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed owned membership response bodies are
    // code/schema mismatches. Exact command statuses are guarded by apiCommand204.
    super(message);
    this.name = "MediaLibraryContractDefect";
  }
}

export type MediaDeleteResult =
  | {
      kind: "Removed";
      removedFromLibraryIds: string[];
      remainingReferenceCount: number;
    }
  | {
      kind: "Hidden";
      removedFromLibraryIds: string[];
      remainingReferenceCount: number;
    }
  | { kind: "Deleting" };

// Same-system strict decode: the backend produces exactly this camelCase tagged
// union; any other shape is a code/schema-mismatch defect.
function decodeMediaDeleteResult(raw: unknown): MediaDeleteResult {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new MediaLibraryContractDefect(
      "Invalid MediaDeleteResult envelope: expected { data: {...} }",
    );
  }
  const data = raw.data;
  if (data.kind === "Deleting") {
    return { kind: "Deleting" };
  }
  if (data.kind === "Removed" || data.kind === "Hidden") {
    const ids = data.removedFromLibraryIds;
    const count = data.remainingReferenceCount;
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string") ||
      typeof count !== "number" ||
      !Number.isInteger(count)
    ) {
      throw new MediaLibraryContractDefect(
        `Invalid MediaDeleteResult.${data.kind}: bad fields`,
      );
    }
    return {
      kind: data.kind,
      removedFromLibraryIds: ids,
      remainingReferenceCount: count,
    };
  }
  throw new MediaLibraryContractDefect(
    `Invalid MediaDeleteResult.kind: ${JSON.stringify(data.kind)}`,
  );
}

export async function deleteMedia(mediaId: string): Promise<MediaDeleteResult> {
  const response = await apiFetch<unknown>(`/api/media/${mediaId}`, {
    method: "DELETE",
  });
  return decodeMediaDeleteResult(response);
}

interface FetchMediaLibraryMembershipsOptions {
  signal?: AbortSignal;
}

export async function fetchMediaLibraryMemberships(
  mediaId: string,
  { signal }: FetchMediaLibraryMembershipsOptions = {},
): Promise<LibraryTargetPickerItem[]> {
  const response = await apiFetch<unknown>(`/api/media/${mediaId}/libraries`, {
    signal,
  });
  return decodeMediaLibraryMemberships(response);
}

export function decodeMediaLibraryMemberships(
  raw: unknown,
): LibraryTargetPickerItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new MediaLibraryContractDefect(
      "Invalid media-library memberships response: expected a data array.",
    );
  }
  return raw.data.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      (entry.color !== null && typeof entry.color !== "string") ||
      typeof entry.is_in_library !== "boolean" ||
      typeof entry.can_add !== "boolean" ||
      typeof entry.can_remove !== "boolean"
    ) {
      throw new MediaLibraryContractDefect(
        "Invalid media-library memberships response: invalid library entry.",
      );
    }
    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      isInLibrary: entry.is_in_library,
      canAdd: entry.can_add,
      canRemove: entry.can_remove,
    };
  });
}

export async function ensureMediaInLibraries({
  mediaId,
  libraryIds,
  signal,
}: {
  mediaId: string;
  libraryIds: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  await apiCommand204(`/api/media/${mediaId}/libraries`, {
    method: "POST",
    body: JSON.stringify({ library_ids: libraryIds }),
    signal,
  });
}

export async function ensureMediaAbsentFromLibrary({
  mediaId,
  libraryId,
  signal,
}: {
  mediaId: string;
  libraryId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await apiCommand204(`/api/media/${mediaId}/libraries/${libraryId}`, {
    method: "DELETE",
    signal,
  });
}

export function patchLibraryMembership<T extends LibraryTargetPickerItem>(
  libraries: T[],
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
