"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { usePlaybackSource, type PlaybackSource } from "./playbackSource";
import { projectDownloadActions, projectPlaybackAction, projectResourceActions, type ResourceActions } from "@/lib/actions/project";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useActionRuntime, useBusyActionIds, resourceActionRequiresRemote } from "@/lib/actions/ResourceActionsProvider";
import { installedApp, remoteReady, remoteGeneration } from "@/lib/native/admission";
import { ApiError, apiFetch } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import type { PodcastActionFocus } from "./inlineActions";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";

type ReadState =
  | null
  | { readonly kind: "Loading"; readonly ref: string; readonly request: AbortSignal }
  | { readonly kind: "Ready"; readonly ref: string; readonly request: AbortSignal; readonly facts: ResourceActions; readonly generation: number; readonly source: PlaybackSource | null }
  | { readonly kind: "Failed"; readonly ref: string; readonly request: AbortSignal; readonly feedback: FeedbackContent; readonly connectionRequired: boolean };

/**
 * Reads one invocation's authoritative facts. The caller owns its signal and
 * visible lifetime; abort, replacement and departure cancel and forget the read.
 * Projection uses current runtime availability; this reader owns no menu or timer.
 */
export function useResourceActions(ref: string | null, onDefect?: (defect: { readonly error: unknown }) => void, focus?: PodcastActionFocus) {
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
    if (!remoteReady()) {
      setLoad({ kind: "Failed", ref, request, connectionRequired: true, feedback: { tone: "Neutral", title: "requires a connection" } });
      return;
    }
    const generation = remoteGeneration();
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
      request.removeEventListener("abort", attempt.cancel);
      flight.current = null;
      setLoad({ kind: "Ready", ref, request, facts: response.data, generation, source });
    }, (error: unknown) => {
      if (flight.current !== attempt || subject.current !== ref || request.aborted) return;
      request.removeEventListener("abort", attempt.cancel);
      flight.current = null;
      if (modeledApiError(error, fail.current)) setLoad({
        kind: "Failed", ref, request, connectionRequired: !remoteReady(), feedback: !remoteReady() ? { tone: "Neutral", title: "requires a connection" } : { tone: "Warning", title: "actions couldn’t load" },
      });
    });
  }, [ref, source]);

  useLayoutEffect(() => () => {
    if (flight.current?.ref === ref) flight.current.cancel();
  }, [ref]);

  useLayoutEffect(() => {
    const attempt = flight.current;
    if (ctx.online || !installedApp || attempt === null) return;
    attempt.cancel();
    setLoad({ kind: "Failed", ref: attempt.ref, request: attempt.request, connectionRequired: true, feedback: { tone: "Neutral", title: "requires a connection" } });
  }, [ctx.online]);

  const state = load !== null && load.ref === ref && !load.request.aborted ? load : null;
  return {
    prepare,
    state: state?.kind === "Ready" ? {
      ...state, options: projectResourceActions(state.facts, ctx, busy, command => run({
        ...command,
        execute: () => {
          if (installedApp && resourceActionRequiresRemote(command.id, command.tracked) && state.generation !== remoteGeneration())
            throw new ApiError(409, "E_ACTION_FACTS_STALE", "reopen actions to check current availability");
          return command.execute();
        },
      }), pane?.paneId ?? null, state.source, focus).map<ActionDescriptor>(action => {
        const transcript = state.facts.actions.find(item => item.kind === "Transcript");
        const tracked = action.id !== "Transcript" || transcript?.kind !== "Transcript" || !["ready", "partial", "queued", "running"].includes(transcript.state);
        if (!installedApp || !resourceActionRequiresRemote(action.id, tracked) || ctx.online && state.generation === remoteGeneration()) return action;
        return { ...action, disabled: true, disabledReason: ctx.online ? "reopen actions to check current availability" : "requires a connection" };
      }),
    } : state,
  };
}

/**
 * A media principal's device actions from current download and player facts: play a
 * ready download, cancel, retry or remove local work. They need no remote action facts
 * and fabricate none; server-only commands stay with `useResourceActions`.
 */
export function useDeviceActions(ref: string | null, title: string): ActionDescriptor[] {
  const { ctx, run } = useActionRuntime();
  const busy = useBusyActionIds(ref);
  const source = usePlaybackSource();
  const resource = ref === null ? null : parseResourceRef(ref);
  if (resource === null || resource.scheme !== "media") return [];
  const mediaId = resource.id;
  const downloads = projectDownloadActions({ mediaId, title, ctx, busy, run, server: null });
  const downloaded = ctx.offline.kind === "Ready" && ctx.offline.items.some(item =>
    item.media_id === mediaId && item.kind === "podcast_episode" && item.state === "Ready" && item.package_id !== null);
  return downloaded ? [projectPlaybackAction({ mediaId, title, descriptor: null, blocked: null, playbackSource: source, ctx, run }), ...downloads] : downloads;
}
