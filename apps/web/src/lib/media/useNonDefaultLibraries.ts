"use client";

import { useCallback, useRef, useState } from "react";
import {
  type FeedbackContent,
  toFeedback,
} from "@/components/feedback/Feedback";
import {
  fetchNonDefaultLibraries,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";

interface NonDefaultLibraries {
  libraries: LibraryTargetPickerItem[];
  loading: boolean;
  loaded: boolean;
  error: FeedbackContent | null;
  load: () => Promise<void>;
  retry: () => Promise<void>;
}

/**
 * Lazy-loads the user's non-default libraries shaped as library-membership
 * rows (all entries start with `isInLibrary: false` since these are used to
 * pick a *destination*, not to display current membership).
 */
export function useNonDefaultLibraries(): NonDefaultLibraries {
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const loadStateRef = useRef<"idle" | "loading" | "loaded" | "failed">(
    "idle",
  );
  const inFlightLoadRef = useRef<Promise<void> | null>(null);

  const runLoad = useCallback(async (forceRetry: boolean) => {
    if (inFlightLoadRef.current) {
      return inFlightLoadRef.current;
    }
    if (
      loadStateRef.current === "loaded" ||
      (loadStateRef.current === "failed" && !forceRetry)
    ) {
      return;
    }

    loadStateRef.current = "loading";
    setLoading(true);
    setError(null);

    const request = (async () => {
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
        loadStateRef.current = "loaded";
      } catch (loadError) {
        setError(toFeedback(loadError, { fallback: "Failed to load libraries" }));
        setLibraries([]);
        setLoaded(false);
        loadStateRef.current = "failed";
      } finally {
        inFlightLoadRef.current = null;
        setLoading(false);
      }
    })();

    inFlightLoadRef.current = request;
    return request;
  }, []);

  const load = useCallback(() => runLoad(false), [runLoad]);
  const retry = useCallback(() => runLoad(true), [runLoad]);

  return { libraries, loading, loaded, error, load, retry };
}
