import { apiFetch } from "@/lib/api/client";

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

interface MediaDeleteResponse {
  data: { hard_deleted: boolean };
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
): Promise<{ hardDeleted: boolean }> {
  const response = await apiFetch<MediaDeleteResponse>(
    `/api/media/${mediaId}?library_id=${encodeURIComponent(libraryId)}`,
    { method: "DELETE" },
  );
  return { hardDeleted: response.data.hard_deleted };
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
