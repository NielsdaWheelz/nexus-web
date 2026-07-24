"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toFeedback } from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  addLibraryPlacement,
  listLibraryPlacements,
  removeLibraryPlacement,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";

type MutationState =
  | { kind: "Idle" }
  | { kind: "Running"; sessionKey: number; libraryId: string };

interface LibraryPlacementState {
  libraries: LibraryPlacementOption[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  busyLibraryId: string | null;
  retry: () => void;
  addToLibrary: (libraryId: string) => void;
  removeFromLibrary: (libraryId: string) => void;
}

function libraryPlacementErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (isApiError(error) && !isSameSystemApiDefect(error)) {
    return toFeedback(error, { fallback }).title;
  }
  if (error instanceof TypeError) {
    return toFeedback(error, { fallback }).title;
  }
  throw error;
}

export function useLibraryPlacement(
  session: LibraryPlacementSession | null,
): LibraryPlacementState {
  const [libraries, setLibraries] = useState<LibraryPlacementOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<MutationState>({ kind: "Idle" });
  const [defect, setDefect] = useState<unknown>(null);
  const currentSessionKeyRef = useRef(session?.key);
  const currentSessionRef = useRef(session);
  const listAbortRef = useRef<AbortController | null>(null);
  const mutationRunningRef = useRef(false);
  currentSessionKeyRef.current = session?.key;
  currentSessionRef.current = session;

  const load = useCallback(
    async (
      requestedSession: LibraryPlacementSession,
      preserveLibraries: boolean,
    ) => {
      listAbortRef.current?.abort();
      const abort = new AbortController();
      listAbortRef.current = abort;
      const key = requestedSession.key;
      if (!preserveLibraries) setLibraries([]);
      setLoading(true);
      setError(null);
      try {
        const next = await listLibraryPlacements(requestedSession.target, {
          signal: abort.signal,
        });
        if (
          listAbortRef.current === abort &&
          currentSessionKeyRef.current === key
        ) {
          setLibraries(next);
        }
      } catch (loadError) {
        if (isAbortError(loadError)) return;
        if (handleUnauthenticatedApiError(loadError)) return;
        if (
          listAbortRef.current !== abort ||
          currentSessionKeyRef.current !== key
        ) {
          return;
        }
        try {
          setError(
            libraryPlacementErrorMessage(
              loadError,
              "Failed to load libraries",
            ),
          );
        } catch (caughtDefect) {
          setDefect(caughtDefect);
        }
      } finally {
        if (
          listAbortRef.current === abort &&
          currentSessionKeyRef.current === key
        ) {
          listAbortRef.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    setDefect(null);
    setError(null);
    setLibraries([]);
    if (!session) {
      setLoading(false);
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      return;
    }
    void load(session, false);
    return () => {
      listAbortRef.current?.abort();
      listAbortRef.current = null;
    };
  }, [load, session]);

  const mutate = useCallback(
    async (libraryId: string, operation: "Add" | "Remove") => {
      if (!session || mutationRunningRef.current) return;
      mutationRunningRef.current = true;
      const key = session.key;
      let commandSucceeded = false;
      setMutation({ kind: "Running", sessionKey: key, libraryId });
      setError(null);
      try {
        if (operation === "Add") {
          await addLibraryPlacement(session.target, libraryId);
        } else {
          await removeLibraryPlacement(session.target, libraryId);
        }
        commandSucceeded = true;
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        if (currentSessionKeyRef.current === key) {
          try {
            setError(
              libraryPlacementErrorMessage(
                mutationError,
                operation === "Add"
                  ? "Failed to add item to library"
                  : "Failed to remove item from library",
              ),
            );
          } catch (caughtDefect) {
            setDefect(caughtDefect);
          }
        }
      } finally {
        const currentSession = currentSessionRef.current;
        if (
          currentSession &&
          (commandSucceeded || currentSession.key !== key)
        ) {
          await load(currentSession, true);
        }
        mutationRunningRef.current = false;
        setMutation({ kind: "Idle" });
      }
    },
    [load, session],
  );

  if (defect !== null) throw defect;

  return {
    libraries,
    loading,
    error,
    busy: mutation.kind === "Running",
    busyLibraryId:
      mutation.kind === "Running" && mutation.sessionKey === session?.key
        ? mutation.libraryId
        : null,
    retry: () => {
      if (session && !mutationRunningRef.current) void load(session, true);
    },
    addToLibrary: (libraryId) => void mutate(libraryId, "Add"),
    removeFromLibrary: (libraryId) => void mutate(libraryId, "Remove"),
  };
}
