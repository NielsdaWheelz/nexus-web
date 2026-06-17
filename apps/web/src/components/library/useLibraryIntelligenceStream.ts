"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
import {
  toLibraryIntelligenceEvent,
  type LiStreamEvent,
} from "@/lib/api/sse/libraryIntelligenceEvents";
import { createRandomId } from "@/lib/createRandomId";

interface GenerateResponse {
  data: { artifact_id: string; revision_id: string };
}

/**
 * Slim driver for a library-intelligence revision build. Transport, token
 * minting, and reconnect live in `useGenerationRun` (kind `library-intelligence`);
 * this hook owns only the 3-event decode (`meta`/`progress`/`done`), the
 * `building` + textual `progress` pair, and the single subscribed revision id.
 * The reduce is a single structured call (no token streaming), so completion is
 * reported via `onDone` off the terminal `done` event's own `revision_id`.
 */
export function useLibraryIntelligenceStream({
  libraryId,
  onDone,
  onError,
}: {
  libraryId: string;
  /** Fired on the terminal `done` event. `errorCode` is non-null on failure. */
  onDone: (revisionId: string, errorCode: string | null) => void;
  onError: (err: Error) => void;
}): {
  building: boolean;
  progress: string | null;
  generate: (instruction?: string | null) => Promise<void>;
  subscribe: (revisionId: string) => Promise<void>;
} {
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const handleEvent = useCallback((event: LiStreamEvent) => {
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
        setRevisionId(null);
        onDoneRef.current(
          event.data.revision_id,
          event.data.status === "failed" ? event.data.error_code : null,
        );
        break;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }, []);

  const { phase } = useGenerationRun<LiStreamEvent>({
    kind: "library-intelligence",
    id: revisionId,
    decode: toLibraryIntelligenceEvent,
    isTerminal: (event) => event.type === "done",
    onEvent: handleEvent,
  });

  // A fatal stream error (token mint or unrecoverable transport) ends the build.
  useEffect(() => {
    if (phase !== "failed") return;
    setBuilding(false);
    setRevisionId(null);
    onErrorRef.current(new Error("Library dossier stream failed"));
  }, [phase]);

  const subscribe = useCallback(async (nextRevisionId: string) => {
    setBuilding(true);
    setRevisionId(nextRevisionId);
  }, []);

  const generate = useCallback(async (instruction?: string | null) => {
    const idempotency_key = createRandomId("li-gen");
    const trimmedInstruction = instruction?.trim() ?? "";
    const request: RequestInit = {
      method: "POST",
      headers: { "Idempotency-Key": idempotency_key },
    };
    if (trimmedInstruction.length > 0) {
      request.body = JSON.stringify({ instruction: trimmedInstruction });
    }
    let res: GenerateResponse;
    try {
      res = await apiFetch<GenerateResponse>(
        `/api/libraries/${libraryId}/intelligence/generate`,
        request,
      );
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      onErrorRef.current(
        err instanceof Error ? err : new Error("Failed to start generation"),
      );
      return;
    }
    await subscribe(res.data.revision_id);
  }, [libraryId, subscribe]);

  return { building, progress, generate, subscribe };
}
