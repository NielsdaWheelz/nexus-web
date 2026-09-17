"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { fetchHighlights } from "@/lib/highlights/api";
import type { Highlight } from "@/lib/highlights/highlightContract";

type HostedTextHighlightStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

interface ProjectionState {
  readonly key: string | null;
  readonly highlights: Highlight[];
  readonly status: HostedTextHighlightStatus;
  readonly error: ApiError | null;
  readonly settled: boolean;
}

interface TextHighlightMutationSession {
  readonly key: string;
  readonly generation: number;
}

interface HostedTextHighlights {
  readonly highlights: Highlight[];
  readonly status: HostedTextHighlightStatus;
  readonly error: ApiError | null;
  readonly initialLoading: boolean;
  readonly retry: () => void;
  readonly reload: () => void;
  readonly beginMutation: () => TextHighlightMutationSession | null;
  readonly projectMutation: (
    session: TextHighlightMutationSession,
    transform: (highlights: Highlight[]) => Highlight[],
  ) => boolean;
  readonly reconcileMutation: (
    session: TextHighlightMutationSession,
  ) => Promise<Highlight[] | null>;
}

function emptyProjection(
  key: string | null,
  status: HostedTextHighlightStatus,
): ProjectionState {
  return { key, highlights: [], status, error: null, settled: false };
}

/**
 * Owns the active reflowable reader's hosted Highlight projection.
 *
 * Reads are keyed by media + fragment, use the shared browser retry policy,
 * and are latest-wins with real request cancellation. Empty is a successful
 * projection. Mutation sessions let the route project an authoritative write
 * only while its source is still active, then reconcile through this same
 * read owner.
 */
export function useHostedTextHighlights({
  mediaId,
  fragmentId,
}: {
  readonly mediaId: string;
  readonly fragmentId: string | null;
}): HostedTextHighlights {
  const key = fragmentId === null ? null : `${mediaId}:${fragmentId}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const handleUnauthenticatedApiError = useUnauthenticatedApiHandler();
  const [state, setState] = useState<ProjectionState>(() =>
    emptyProjection(key, key === null ? "idle" : "loading"),
  );
  const [defect, setDefect] = useState<{
    readonly key: string;
    readonly error: unknown;
  } | null>(null);

  const isCurrentSession = useCallback(
    (session: TextHighlightMutationSession) =>
      session.key === keyRef.current &&
      session.generation === generationRef.current,
    [],
  );

  const load = useCallback(
    async (
      requiredSession: TextHighlightMutationSession | null = null,
    ): Promise<Highlight[] | null> => {
      if (key === null || fragmentId === null) return null;
      if (requiredSession !== null && !isCurrentSession(requiredSession)) {
        return null;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const generation = ++generationRef.current;
      setDefect(null);
      setState((current) => ({
        key,
        highlights: current.key === key ? current.highlights : [],
        status: "loading",
        error: null,
        settled: current.key === key && current.settled,
      }));

      try {
        const highlights = await requestWithRetry(
          (signal) => fetchHighlights(fragmentId, signal),
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          generation !== generationRef.current ||
          key !== keyRef.current
        ) {
          return null;
        }
        setState({
          key,
          highlights,
          status: "ready",
          error: null,
          settled: true,
        });
        return highlights;
      } catch (error) {
        if (
          controller.signal.aborted ||
          isAbortError(error) ||
          generation !== generationRef.current ||
          key !== keyRef.current
        ) {
          return null;
        }
        if (handleUnauthenticatedApiError(error)) return null;
        if (!isApiError(error) || isSameSystemApiDefect(error)) {
          setDefect({ key, error });
          return null;
        }
        setState((current) => ({
          key,
          highlights: current.key === key ? current.highlights : [],
          status: "error",
          error,
          settled: true,
        }));
        return null;
      }
    },
    [
      fragmentId,
      handleUnauthenticatedApiError,
      isCurrentSession,
      key,
    ],
  );

  useEffect(() => {
    if (key === null) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      generationRef.current += 1;
      setDefect(null);
      setState(emptyProjection(null, "idle"));
      return;
    }
    void load();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      generationRef.current += 1;
    };
  }, [key, load]);

  const retry = useCallback(() => {
    void load();
  }, [load]);

  const beginMutation = useCallback((): TextHighlightMutationSession | null => {
    const currentKey = keyRef.current;
    if (currentKey === null) return null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    const generation = ++generationRef.current;
    setState((current) =>
      current.key === currentKey
        ? { ...current, status: "ready", error: null, settled: true }
        : {
            ...emptyProjection(currentKey, "ready"),
            settled: true,
          },
    );
    return { key: currentKey, generation };
  }, []);

  const projectMutation = useCallback(
    (
      session: TextHighlightMutationSession,
      transform: (highlights: Highlight[]) => Highlight[],
    ): boolean => {
      if (!isCurrentSession(session)) return false;
      setState((current) => {
        if (current.key !== session.key) return current;
        return {
          key: session.key,
          highlights: transform(current.highlights),
          status: "ready",
          error: null,
          settled: true,
        };
      });
      return true;
    },
    [isCurrentSession],
  );

  const reconcileMutation = useCallback(
    (session: TextHighlightMutationSession) => load(session),
    [load],
  );

  if (defect?.key === key) throw defect.error;

  const current =
    state.key === key
      ? state
      : emptyProjection(key, key === null ? "idle" : "loading");
  return {
    highlights: current.highlights,
    status: current.status,
    error: current.error,
    initialLoading: current.status === "loading" && !current.settled,
    retry,
    reload: retry,
    beginMutation,
    projectMutation,
    reconcileMutation,
  };
}
