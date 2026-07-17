import { apiFetch } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";

export interface LibraryTargetPickerItem {
  id: string;
  name: string;
  color: string | null;
  isInLibrary: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

interface MediaLibrariesResponse {
  data: Array<{
    id: string;
    name: string;
    color: string | null;
    is_default?: boolean;
    is_in_library: boolean;
    can_add: boolean;
    can_remove: boolean;
  }>;
}

/**
 * Tagged result of `DELETE /media/{id}` (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1). `Removed`
 * dropped a scoped library reference with lifetime references remaining;
 * `Hidden` recorded the viewer hide marker (whole-workspace removal with
 * references remaining); `Deleting` removed the last reference and scheduled
 * physical deletion — callers treat it as removal-in-progress.
 */
export type MediaDeleteResult =
  | { kind: "Removed"; removedFromLibraryIds: string[]; remainingReferenceCount: number }
  | { kind: "Hidden"; removedFromLibraryIds: string[]; remainingReferenceCount: number }
  | { kind: "Deleting" };

// Same-system strict decode: the backend produces exactly this camelCase tagged
// union; any other shape is a code/schema-mismatch defect.
function decodeMediaDeleteResult(raw: unknown): MediaDeleteResult {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error("Invalid MediaDeleteResult envelope: expected { data: {...} }");
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
      throw new Error(`Invalid MediaDeleteResult.${data.kind}: bad fields`);
    }
    return { kind: data.kind, removedFromLibraryIds: ids, remainingReferenceCount: count };
  }
  throw new Error(`Invalid MediaDeleteResult.kind: ${JSON.stringify(data.kind)}`);
}

/**
 * The one `DELETE /media/{id}` caller. With `libraryId` it removes that scoped
 * library reference; without it, it removes/hides across the whole workspace.
 */
export async function deleteMedia(
  mediaId: string,
  options: { libraryId?: string } = {},
): Promise<MediaDeleteResult> {
  const query =
    options.libraryId !== undefined
      ? `?library_id=${encodeURIComponent(options.libraryId)}`
      : "";
  const response = await apiFetch<unknown>(`/api/media/${mediaId}${query}`, {
    method: "DELETE",
  });
  return decodeMediaDeleteResult(response);
}

interface FetchMediaLibraryMembershipsOptions {
  /** Drop the user's default library from the response (used by media-detail pickers). */
  excludeDefault?: boolean;
}

export async function fetchMediaLibraryMemberships(
  mediaId: string,
  { excludeDefault = false }: FetchMediaLibraryMembershipsOptions = {},
): Promise<LibraryTargetPickerItem[]> {
  const response = await apiFetch<MediaLibrariesResponse>(
    `/api/media/${mediaId}/libraries`,
  );
  return response.data
    .filter((library) => !excludeDefault || !library.is_default)
    .map((library) => ({
      id: library.id,
      name: library.name,
      color: library.color,
      isInLibrary: library.is_in_library,
      canAdd: library.can_add,
      canRemove: library.can_remove,
    }));
}

export async function addMediaToLibrary(
  mediaId: string,
  libraryId: string,
): Promise<void> {
  await apiFetch(`/api/libraries/${libraryId}/media`, {
    method: "POST",
    body: JSON.stringify({ media_id: mediaId }),
  });
}

export async function removeMediaFromLibrary(
  mediaId: string,
  libraryId: string,
): Promise<MediaDeleteResult> {
  return deleteMedia(mediaId, { libraryId });
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
