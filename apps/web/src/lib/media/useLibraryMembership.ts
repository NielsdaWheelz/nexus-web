"use client";

import { useCallback, useEffect, useState } from "react";
import { toFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  addMediaToLibrary,
  fetchMediaLibraryMemberships,
  patchLibraryMembership,
  removeMediaFromLibrary,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";
import { usePaneRouter } from "@/lib/panes/paneRuntime";

interface LibraryMembership {
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
      setLibraries(
        await fetchMediaLibraryMemberships(mediaId, { excludeDefault: true }),
      );
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
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
        await addMediaToLibrary(mediaId, libraryId);
        setLibraries((current) =>
          patchLibraryMembership(current, libraryId, true),
        );
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
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
        const result = await removeMediaFromLibrary(mediaId, libraryId);
        if (result.kind === "Deleting") {
          // Last reference removed: the media is being deleted server-side, so
          // this pane's subject is gone — leave it.
          router.push("/libraries");
          return;
        }
        setLibraries((current) =>
          patchLibraryMembership(current, libraryId, false),
        );
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
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
