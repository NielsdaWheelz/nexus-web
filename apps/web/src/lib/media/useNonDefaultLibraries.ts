"use client";

import { useCallback, useState } from "react";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import {
  type FeedbackContent,
  toFeedback,
} from "@/components/feedback/Feedback";
import { fetchNonDefaultLibraries } from "@/lib/media/mediaLibraries";

interface NonDefaultLibraries {
  libraries: LibraryTargetPickerItem[];
  loading: boolean;
  loaded: boolean;
  error: FeedbackContent | null;
  load: () => Promise<void>;
}

/**
 * Lazy-loads the user's non-default libraries shaped for a `LibraryTargetPicker`
 * (all entries start with `isInLibrary: false` since the picker is used to pick
 * a *destination*, not to display current membership). Idempotent — repeat
 * calls are no-ops while loading or after a successful load.
 */
export function useNonDefaultLibraries(): NonDefaultLibraries {
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);

  const load = useCallback(async () => {
    if (loading || loaded) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const summaries = await fetchNonDefaultLibraries();
      setLibraries(
        summaries.map((library) => ({
          id: library.id,
          name: library.name,
          color: library.color ?? null,
          isInLibrary: false,
          canAdd: true,
          canRemove: false,
        })),
      );
      setLoaded(true);
    } catch (loadError) {
      setError(toFeedback(loadError, { fallback: "Failed to load libraries" }));
      setLibraries([]);
    } finally {
      setLoading(false);
    }
  }, [loaded, loading]);

  return { libraries, loading, loaded, error, load };
}
