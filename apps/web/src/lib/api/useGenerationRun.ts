"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { sseClientDirect, type SseBackoffConfig } from "./sse-client";
import { fetchStreamToken } from "./streamToken";

export type GenerationRunKind =
  | "chat-runs"
  | "oracle-readings"
  | "library-intelligence"
  | "media";

export type GenerationRunPhase =
  | "idle"
  | "connecting"
  | "streaming"
  | "done"
  | "failed";

/**
 * Stream path prefix per run kind, joined as `${prefix}/${id}/events` under
 * the stream base URL. All four browser-callable SSE endpoints live under
 * `/stream/` (one prefix predicate guards the bearer-auth boundary).
 */
export const GENERATION_RUN_STREAM_PATHS: Record<GenerationRunKind, string> = {
  "chat-runs": "/stream/chat-runs",
  "oracle-readings": "/stream/oracle-readings",
  "library-intelligence": "/stream/library-intelligence",
  media: "/stream/media",
};

/**
 * Open one SSE subscription to a generation run: mint a fresh stream token,
 * build the per-kind stream URL, and hand both to `sseClientDirect`. The single
 * non-hook transport opener — `useGenerationRun` (the single-id hook) and chat's
 * imperative multi-run tailer both delegate their token-mint + URL + connect
 * wiring here, so no surface re-implements it. The caller owns every
 * `sseClientDirect` arg except `url`/`initialToken` (this owns the token mint).
 *
 * Honors `sseArgs.signal`: if the caller aborted during the mint, returns a
 * no-op without connecting (mirroring the hook's post-mint abort check).
 */
export async function openGenerationRunStream<TEvent>(
  kind: GenerationRunKind,
  id: string,
  sseArgs: Omit<Parameters<typeof sseClientDirect<TEvent>>[0], "url" | "initialToken">,
): Promise<() => void> {
  const connection = await fetchStreamToken();
  if (sseArgs.signal?.aborted) return () => {};
  return sseClientDirect<TEvent>({
    url: `${connection.stream_base_url}${GENERATION_RUN_STREAM_PATHS[kind]}/${id}/events`,
    // The first connect reuses the token minted above (it also carries the
    // stream base URL); sseClientDirect mints fresh ones for every reconnect.
    initialToken: connection.token,
    ...sseArgs,
  });
}

/**
 * One SSE subscription to a generation run: transport + lifecycle only.
 * Domain machinery (chat's multi-run registry, oracle's reducer, LI's
 * progress mapping, media's snapshot folding) stays in the per-surface layer
 * on top.
 *
 * Lifecycle: `id: null` is idle; setting it connects (token mint → stream),
 * the first event moves to "streaming", the terminal event to "done", and a
 * fatal error or reconnect exhaustion to "failed". `retry()` re-subscribes
 * from scratch; `abort()` detaches cleanly back to idle. Events are delivered
 * in stream order; reconnects resume from the last seen event id.
 */
export function useGenerationRun<TEvent>(cfg: {
  kind: GenerationRunKind;
  /** Run/owner id to stream; null = idle (no connection). */
  id: string | null;
  decode: (type: string, data: unknown, id: string) => TEvent;
  /** Unified terminal predicate (`type === "done"`). */
  isTerminal: (e: TEvent) => boolean;
  onEvent: (e: TEvent) => void;
  /** Initial stream cursor (oracle seq, chat Last-Event-ID). */
  resume?: { lastEventId?: string };
  reconnect?: {
    max?: number;
    backoff?: SseBackoffConfig;
    onReconnect?: (attempt: number) => Promise<"continue" | "stop">;
  };
}): { phase: GenerationRunPhase; retry: () => void; abort: () => void } {
  const { kind, id } = cfg;
  const [phase, setPhase] = useState<GenerationRunPhase>("idle");
  const [nonce, setNonce] = useState(0);
  const [detachedKey, setDetachedKey] = useState<string | null>(null);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const subscriptionKey = id === null ? null : `${kind}:${id}:${nonce}`;
  const detached = subscriptionKey !== null && subscriptionKey === detachedKey;

  useEffect(() => {
    if (id === null || detached) {
      setPhase("idle");
      return;
    }
    const controller = new AbortController();
    let stopRequested = false;
    setPhase("connecting");

    void (async () => {
      try {
        const { resume, reconnect } = cfgRef.current;
        await openGenerationRunStream<TEvent>(kind, id, {
          decode: (type, data, eventId) => cfgRef.current.decode(type, data, eventId),
          isTerminal: (event) => cfgRef.current.isTerminal(event),
          onEvent: (event) => {
            if (controller.signal.aborted) return;
            setPhase((current) => (current === "connecting" ? "streaming" : current));
            cfgRef.current.onEvent(event);
          },
          onError: (err) => {
            if (controller.signal.aborted) return;
            console.error(`Generation run stream failed (${kind}):`, err);
            setPhase("failed");
          },
          onComplete: (terminalEventSeen) => {
            if (controller.signal.aborted) return;
            if (terminalEventSeen || stopRequested) setPhase("done");
          },
          onReconnect: reconnect?.onReconnect
            ? async (attempt) => {
                const handler = cfgRef.current.reconnect?.onReconnect;
                const decision = handler ? await handler(attempt) : "continue";
                if (decision === "stop") stopRequested = true;
                return decision;
              }
            : undefined,
          signal: controller.signal,
          lastEventId: resume?.lastEventId,
          maxReconnects: reconnect?.max,
          backoff: reconnect?.backoff,
        });
      } catch (err) {
        if (controller.signal.aborted || handleUnauthenticatedApiError(err)) {
          return;
        }
        console.error(`Failed to open generation run stream (${kind}):`, err);
        setPhase("failed");
      }
    })();

    return () => controller.abort();
  }, [kind, id, nonce, detached]);

  const retry = useCallback(() => {
    setDetachedKey(null);
    setNonce((value) => value + 1);
  }, []);

  const abort = useCallback(() => {
    setDetachedKey(subscriptionKey);
  }, [subscriptionKey]);

  return { phase, retry, abort };
}
