"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import {
  toLibraryIntelligenceEvent,
  type LiStreamEvent,
} from "@/lib/api/sse/libraryIntelligenceEvents";
import { createRandomId } from "@/lib/createRandomId";

interface GenerateResponse {
  data: { artifact_id: string; revision_id: string; run_id: string };
}

/**
 * Slim SSE engine for a library-intelligence revision build. Modeled on
 * `useChatRunTail`: a single-use first stream token then fresh tokens per
 * (re)connect, a `mountedRef` guard, and abort-on-unmount. The reduce is a
 * single structured call (no token streaming required), so this hook tracks
 * `building` + textual `progress` and reports completion via `onDone`.
 */
export function useLibraryIntelligenceStream({
  libraryId,
  onDone,
  onError,
}: {
  libraryId: string;
  /** Fired on the terminal `done` event. `error` is non-null on failure. */
  onDone: (revisionId: string, error: string | null) => void;
  onError: (err: Error) => void;
}): {
  building: boolean;
  progress: string | null;
  generate: () => Promise<void>;
  subscribe: (revisionId: string) => Promise<void>;
} {
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const abortRef = useRef<(() => void) | null>(null);
  const subscribedRevisionRef = useRef<string | null>(null);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.();
      abortRef.current = null;
    };
  }, []);

  const subscribe = useCallback(async (revisionId: string) => {
    if (!mountedRef.current) return;
    // Already streaming this revision: do not open a second connection.
    if (subscribedRevisionRef.current === revisionId && abortRef.current) {
      return;
    }
    abortRef.current?.();
    subscribedRevisionRef.current = revisionId;
    setBuilding(true);

    let streamBaseUrl: string;
    let firstStreamToken: string | null = null;
    try {
      const tokenResponse = await fetchStreamToken();
      streamBaseUrl = tokenResponse.stream_base_url;
      firstStreamToken = tokenResponse.token;
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!mountedRef.current) return;
      setBuilding(false);
      onErrorRef.current(
        err instanceof Error ? err : new Error("Failed to fetch stream token"),
      );
      return;
    }
    if (!mountedRef.current || subscribedRevisionRef.current !== revisionId) {
      return;
    }

    const abort = sseClientDirect<LiStreamEvent>({
      url: `${streamBaseUrl}/stream/library-intelligence/${revisionId}/events`,
      streamToken: async () => {
        if (firstStreamToken !== null) {
          const streamToken = firstStreamToken;
          firstStreamToken = null;
          return streamToken;
        }
        return (await fetchStreamToken()).token;
      },
      decode: toLibraryIntelligenceEvent,
      isTerminal: (event) => event.type === "done",
      onEvent: (event) => {
        if (!mountedRef.current || subscribedRevisionRef.current !== revisionId) {
          return;
        }
        switch (event.type) {
          case "meta":
            setBuilding(true);
            break;
          case "progress":
            setProgress(event.data.message);
            break;
          case "done":
            setBuilding(false);
            setProgress(null);
            abortRef.current = null;
            subscribedRevisionRef.current = null;
            onDoneRef.current(revisionId, event.data.error);
            break;
          default: {
            const _exhaustive: never = event;
            return _exhaustive;
          }
        }
      },
      onError: (err) => {
        if (!mountedRef.current || subscribedRevisionRef.current !== revisionId) {
          return;
        }
        setBuilding(false);
        subscribedRevisionRef.current = null;
        onErrorRef.current(err);
      },
    });
    abortRef.current = abort;
  }, []);

  const generate = useCallback(async () => {
    if (!mountedRef.current) return;
    const idempotency_key = createRandomId("li-gen");
    let res: GenerateResponse;
    try {
      res = await apiFetch<GenerateResponse>(
        `/api/libraries/${libraryId}/intelligence/generate`,
        { method: "POST", body: JSON.stringify({ idempotency_key }) },
      );
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!mountedRef.current) return;
      onErrorRef.current(
        err instanceof Error ? err : new Error("Failed to start generation"),
      );
      return;
    }
    await subscribe(res.data.revision_id);
  }, [libraryId, subscribe]);

  return { building, progress, generate, subscribe };
}
