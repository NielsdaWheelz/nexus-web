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
import { fetchHighlight, fetchHighlights, upsertHighlightSorted } from "@/lib/highlights/api";
import type { Highlight } from "@/lib/highlights/highlightContract";

export interface TextHighlightDefect { readonly key: string; readonly error: unknown; readonly retry: () => void }

export type HostedTextHighlightStatus =
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
  readonly selectedHighlight: Highlight | null;
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
  readonly readMutationHighlight: (
    session: TextHighlightMutationSession,
    highlightId: string,
  ) => Promise<Highlight | null>;
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
 * Fragment paint reads use media + fragment; addressed detail uses media +
 * highlight identity independently of viewport membership. Both share retry,
 * cancellation and latest-request ownership. Empty is a successful
 * projection. Mutation sessions let the route project an authoritative write
 * only while its source is still active, then reconcile through this same
 * read owner.
 */
export function useHostedTextHighlights({
  mediaId,
  source,
  onDefect,
}: {
  readonly mediaId: string;
  readonly onDefect?: (defect: TextHighlightDefect | null) => void;
  readonly source:
    | { readonly kind: "Fragment"; readonly fragmentId: string }
    | { readonly kind: "Detail"; readonly fragmentId: string | null; readonly highlightId: string | null }
    | null;
}): HostedTextHighlights {
  const fragmentId = source?.fragmentId ?? null;
  const sourceKind = source?.kind ?? null;
  const selectedId = source?.kind === "Detail" ? source.highlightId : null;
  const loadFragmentId = sourceKind === "Fragment" ? fragmentId : null;
  const key = sourceKind === "Detail" ? `${mediaId}:Detail:${selectedId ?? ""}`
    : fragmentId === null ? null : `${mediaId}:${fragmentId}:Fragment`;
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
      highlightId: string | null = selectedId,
    ): Promise<Highlight[] | null> => {
      if (key === null) return null;
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
          async (signal) => {
            if (highlightId === null) return loadFragmentId !== null ? fetchHighlights(loadFragmentId, signal) : [];
            const highlight = await fetchHighlight(highlightId, signal);
            if (highlight.anchor.type !== "fragment_offsets") throw new TypeError("Text highlight detail returned PDF geometry");
            return [{ ...highlight, anchor: highlight.anchor }];
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          generation !== generationRef.current ||
          key !== keyRef.current
        ) {
          return null;
        }
        if (highlights.some((highlight) => highlight.anchor.media_id !== mediaId)) {
          throw new TypeError("Highlight projection returned another media");
        }
        setState((current) => ({
          key,
          highlights: sourceKind === "Detail"
            ? highlights
            : highlightId === null ? highlights : highlights.reduce(
            (rows, highlight) => highlight.anchor.fragment_id === loadFragmentId
              ? upsertHighlightSorted(rows, highlight) : rows,
            current.key === key ? current.highlights : [],
          ),
          status: "ready",
          error: null,
          settled: true,
        }));
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
      loadFragmentId,
      mediaId,
      selectedId,
      sourceKind,
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
        const projected = transform(current.highlights);
        return {
          key: session.key,
          highlights: sourceKind === "Detail" ? projected.filter((highlight) => highlight.id === selectedId) : projected,
          status: "ready",
          error: null,
          settled: true,
        };
      });
      return true;
    },
    [isCurrentSession, selectedId, sourceKind],
  );

  const readMutationHighlight = useCallback(
    async (session: TextHighlightMutationSession, highlightId: string) => {
      const rows = await load(session, highlightId);
      return rows?.[0] ?? null;
    },
    [load],
  );

  const reconcileMutation = useCallback(
    (session: TextHighlightMutationSession) => load(session),
    [load],
  );

  useEffect(() => {
    if (onDefect === undefined) return;
    onDefect(defect?.key === key ? { key: `highlight:${key}`, error: defect.error,
      retry: () => { if (keyRef.current === key) void load(); } } : null);
  }, [defect, key, load, onDefect]);

  if (onDefect === undefined && defect?.key === key) throw defect.error;

  const current =
    state.key === key
      ? state
      : emptyProjection(key, key === null ? "idle" : "loading");
  return {
    highlights: sourceKind === "Detail" ? current.highlights.filter((highlight) => highlight.anchor.fragment_id === fragmentId) : current.highlights,
    selectedHighlight: selectedId === null ? null : current.highlights.find((highlight) => highlight.id === selectedId) ?? null,
    status: current.status,
    error: current.error,
    initialLoading: current.status === "loading" && !current.settled,
    retry,
    reload: retry,
    beginMutation,
    projectMutation,
    readMutationHighlight,
    reconcileMutation,
  };
}
