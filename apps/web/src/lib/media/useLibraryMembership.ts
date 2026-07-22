"use client";

import { useCallback, useEffect, useState } from "react";
import { toFeedback } from "@/components/feedback/Feedback";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  ensureMediaAbsentFromLibrary,
  ensureMediaInLibraries,
  fetchMediaLibraryMemberships,
  patchLibraryMembership,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";

interface LibraryMembership {
  libraries: LibraryTargetPickerItem[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  loadLibraries: () => Promise<void>;
  addToLibrary: (libraryId: string) => Promise<void>;
  removeFromLibrary: (libraryId: string) => Promise<void>;
}

function libraryMembershipErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (
    isApiError(error) ||
    error instanceof TypeError ||
    error instanceof DOMException
  ) {
    return toFeedback(error, { fallback }).title;
  }
  throw error;
}

export function useLibraryMembership(
  mediaId: string | null | undefined,
): LibraryMembership {
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
      setLibraries(await fetchMediaLibraryMemberships(mediaId));
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setLibraries([]);
      setError(libraryMembershipErrorMessage(err, "Failed to load libraries"));
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
        await ensureMediaInLibraries({ mediaId, libraryIds: [libraryId] });
        setLibraries((current) =>
          patchLibraryMembership(current, libraryId, true),
        );
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setError(
          libraryMembershipErrorMessage(err, "Failed to add media to library"),
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
        await ensureMediaAbsentFromLibrary({ mediaId, libraryId });
        setLibraries((current) =>
          patchLibraryMembership(current, libraryId, false),
        );
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setError(
          libraryMembershipErrorMessage(
            err,
            "Failed to remove media from library",
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, mediaId],
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
