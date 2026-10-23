"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { usePlaybackSource, type PlaybackSource } from "./playbackSource";
import { projectResourceActions, type ResourceActions } from "@/lib/actions/project";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

type ReadState =
  | null
  | { readonly kind: "Loading"; readonly ref: string; readonly request: AbortSignal }
  | { readonly kind: "Ready"; readonly ref: string; readonly request: AbortSignal; readonly facts: ResourceActions; readonly source: PlaybackSource | null }
  | { readonly kind: "Failed"; readonly ref: string; readonly request: AbortSignal; readonly feedback: FeedbackContent };

/**
 * Reads one invocation's authoritative facts. The caller owns its signal and
 * visible lifetime; abort, replacement and departure cancel and forget the read.
 * Projection uses current runtime availability; this reader owns no menu or timer.
 */
export function useResourceActions(ref: string | null, { onDefect, capturePodcastRemovalFocus }: {
  readonly onDefect?: (defect: { readonly error: unknown }) => void;
  readonly capturePodcastRemovalFocus?: () => ReturnFocusTarget;
} = {}) {
  const { ctx, run } = useActionRuntime();
  const source = usePlaybackSource();
  const pane = usePaneRuntime();
  const busy = useBusyActionIds(ref);
  const throwHere = useThrowLater();
  const fail = useRef(onDefect ?? throwHere);
  fail.current = onDefect ?? throwHere;
  const subject = useRef(ref);
  subject.current = ref;
  const [load, setLoad] = useState<ReadState>(null);
  const flight = useRef<{ readonly ref: string; readonly request: AbortSignal; cancel(): void } | null>(null);

  const prepare = useCallback((request: AbortSignal) => {
    flight.current?.cancel();
    if (ref === null || request.aborted) return;
    const controller = new AbortController();
    const attempt = {
      ref, request,
      cancel: () => {
        controller.abort();
        request.removeEventListener("abort", attempt.cancel);
        if (flight.current === attempt) {
          flight.current = null;
          setLoad(null);
        }
      },
    };
    flight.current = attempt;
    request.addEventListener("abort", attempt.cancel, { once: true });
    setLoad({ kind: "Loading", ref, request });
    apiFetch<ApiJson<"/resource-items/{resource_ref}/actions", "get">>(
      `/api/resource-items/${encodeURIComponent(ref)}/actions`,
      { signal: controller.signal, cache: "no-store" },
    ).then((response) => {
      if (flight.current !== attempt || subject.current !== ref || request.aborted) return;
      setLoad({ kind: "Ready", ref, request, facts: response.data, source });
    }, (error: unknown) => {
      if (flight.current !== attempt || subject.current !== ref || request.aborted) return;
      if (modeledApiError(error, fail.current)) setLoad({
        kind: "Failed", ref, request, feedback: { tone: "Warning", title: "actions couldn’t load" },
      });
    });
  }, [ref, source]);

  useLayoutEffect(() => () => {
    if (flight.current?.ref === ref) flight.current.cancel();
  }, [ref]);

  const state = load !== null && load.ref === ref && !load.request.aborted ? load : null;
  return {
    prepare,
    state: state?.kind === "Ready" ? {
      ...state, options: projectResourceActions(state.facts, ctx, busy, run, pane?.paneId ?? null, state.source, { capturePodcastRemovalFocus }),
    } : state,
  };
}
