"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { toFeedback } from "@/components/feedback/Feedback";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import { usePaneRouter } from "@/lib/panes/paneRuntime";

interface LibrariesForMediaResponse {
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

export interface LibraryMembership {
  libraries: LibraryTargetPickerItem[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  loadLibraries: () => Promise<void>;
  addToLibrary: (libraryId: string) => Promise<void>;
  removeFromLibrary: (libraryId: string) => Promise<void>;
}

/**
 * Library picker state and CRUD for the active media — load the user's
 * non-default libraries, add/remove the media from them, and clear when the
 * media changes. Removal that hard-deletes the media navigates back to the
 * library list since the route no longer resolves.
 */
export function useLibraryMembership(
  mediaId: string | null | undefined,
): LibraryMembership {
  const router = usePaneRouter();
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mediaId) {
      setLibraries([]);
      setError(null);
    }
  }, [mediaId]);

  const loadLibraries = useCallback(async () => {
    if (!mediaId) {
      setLibraries([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<LibrariesForMediaResponse>(
        `/api/media/${mediaId}/libraries`,
      );
      setLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          })),
      );
    } catch (err) {
      setLibraries([]);
      setError(toFeedback(err, { fallback: "Failed to load libraries" }).title);
    } finally {
      setLoading(false);
    }
  }, [mediaId]);

  const addToLibrary = useCallback(
    async (libraryId: string) => {
      if (!mediaId || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/media`, {
          method: "POST",
          body: JSON.stringify({ media_id: mediaId }),
        });
        setLibraries((current) =>
          current.map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: true,
                  canAdd: false,
                  canRemove: true,
                }
              : library,
          ),
        );
      } catch (err) {
        setError(
          toFeedback(err, { fallback: "Failed to add media to library" }).title,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, mediaId],
  );

  const removeFromLibrary = useCallback(
    async (libraryId: string) => {
      if (!mediaId || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const response = await apiFetch<{ data: { hard_deleted: boolean } }>(
          `/api/media/${mediaId}?library_id=${encodeURIComponent(libraryId)}`,
          { method: "DELETE" },
        );
        if (response.data.hard_deleted) {
          router.push("/libraries");
          return;
        }
        setLibraries((current) =>
          current.map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: false,
                  canAdd: true,
                  canRemove: false,
                }
              : library,
          ),
        );
      } catch (err) {
        setError(
          toFeedback(err, { fallback: "Failed to remove media from library" })
            .title,
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, mediaId, router],
  );

  return {
    libraries,
    loading,
    error,
    busy,
    loadLibraries,
    addToLibrary,
    removeFromLibrary,
  };
}
