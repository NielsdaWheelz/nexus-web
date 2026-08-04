"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  createConversationFindSnapshot,
  matchConversationFindUnits,
  type ConversationFindOccurrence,
  type ConversationFindSnapshot,
} from "@/lib/conversations/conversationFind";
import type { ConversationMessage } from "@/lib/conversations/types";
import type {
  PaneFindResultKey,
  PaneFindSourceKey,
} from "@/lib/panes/paneSearch";
import {
  usePaneFind,
  type PaneFindAdapter,
  type PaneFindController,
  type PaneFindPreviewReceipt,
} from "@/lib/panes/usePaneFind";
import {
  createPaneFindHighlightOwner,
  type PaneFindHighlightOwner,
} from "@/lib/reader/paneFindHighlightRegistry";
import type {
  ChatReadingPosition,
  ChatScrollHandle,
} from "@/components/chat/useChatScroll";
import {
  prepareConversationFindUnits,
  resolveConversationFindRanges,
  type PreparedConversationFindUnit,
} from "@/components/chat/conversationFindDom";

const SELECTED_PATH_SCOPE_ID = "SelectedPath";

type ConversationFindError = {
  readonly kind: "OriginUnavailable";
};

interface ConversationFindAdapter extends PaneFindAdapter<ConversationFindError> {
  invalidate(): void;
  dispose(): void;
}

interface ConversationPaneFindController extends PaneFindController {
  readonly sourceKey: PaneFindSourceKey;
}

function conversationFindErrorMessage(error: ConversationFindError): string {
  switch (error.kind) {
    case "OriginUnavailable":
      return "Your reading position could not be captured.";
  }
}

function cancelled(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelled("Conversation Find request was cancelled.");
  }
}

function createConversationFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getScrollHandle,
  highlightOwner,
}: {
  readonly snapshot: ConversationFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey;
  readonly getScrollHandle: () => ChatScrollHandle | null;
  readonly highlightOwner: PaneFindHighlightOwner;
}): ConversationFindAdapter {
  let prepared: {
    readonly sessionId: number;
    readonly units: readonly PreparedConversationFindUnit[];
  } | null = null;
  let matchesByKey = new Map<
    PaneFindResultKey,
    {
      readonly occurrence: ConversationFindOccurrence;
      readonly ranges: readonly Range[];
    }
  >();
  let origin: ChatReadingPosition | null = null;
  let generation = 0;
  let disposed = false;

  const assertCurrent = (sourceKey: PaneFindSourceKey): void => {
    if (
      disposed ||
      sourceKey !== snapshot.sourceKey ||
      sourceKey !== getCurrentSourceKey()
    ) {
      throw cancelled("Conversation Find source was replaced.");
    }
  };
  const scrollHandle = (): ChatScrollHandle => {
    const scroll = getScrollHandle();
    if (!scroll) {
      throw new Error("Conversation Find scroll owner is unavailable.");
    }
    return scroll;
  };
  const allRanges = (): readonly Range[] =>
    [...matchesByKey.values()].flatMap(({ ranges }) => ranges);
  const invalidate = (): void => {
    generation += 1;
    highlightOwner.clear();
    getScrollHandle()?.clearFindPresentation();
    prepared = null;
    matchesByKey = new Map();
    origin = null;
  };

  return {
    sourceKey: snapshot.sourceKey,
    async prepare(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const transcript = scrollHandle().getTranscriptElement();
      if (!transcript) {
        throw new Error("Conversation Find transcript is unavailable.");
      }
      prepared = {
        sessionId: request.sessionId,
        units: prepareConversationFindUnits({ snapshot, transcript }),
      };
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: SELECTED_PATH_SCOPE_ID,
            label: "Current fork",
          },
        ],
      };
    },
    async find(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      if (request.scopeId !== SELECTED_PATH_SCOPE_ID) {
        throw new Error(`Unknown Conversation Find scope: ${request.scopeId}`);
      }
      if (prepared?.sessionId !== request.sessionId) {
        throw new Error("Conversation Find session was not prepared.");
      }
      const { units } = prepared;
      const matches = matchConversationFindUnits({
        snapshot,
        units,
        query: request.query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
      });
      matchesByKey = new Map();
      if (matches.kind !== "Ready") {
        highlightOwner.clear();
        return {
          ...matches,
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
        };
      }
      for (const occurrence of matches.occurrences) {
        matchesByKey.set(occurrence.key, {
          occurrence,
          ranges: resolveConversationFindRanges({ units, occurrence }),
        });
      }
      highlightOwner.publish({ all: allRanges(), active: [] });
      const rows = matches.occurrences.map(({ row }) => row);
      const initial = rows[0];
      if (!initial) {
        throw new Error(
          "Conversation Find Ready requires at least one occurrence.",
        );
      }
      return {
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows,
        initialActiveKey: initial.key,
      };
    },
    async preview(
      request,
    ): Promise<PaneFindPreviewReceipt<ConversationFindError>> {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      const match = matchesByKey.get(request.key);
      if (!match) {
        throw new Error("Conversation Find occurrence is unavailable.");
      }
      const { occurrence, ranges } = match;
      const scroll = scrollHandle();
      const candidateOrigin = origin ?? scroll.captureReadingPosition();
      if (!candidateOrigin) {
        return {
          kind: "Rejected",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          key: request.key,
          error: { kind: "OriginUnavailable" },
        };
      }
      const previewGeneration = generation;
      const settlement = await scroll.previewFindOccurrence({
        messageId: occurrence.messageId,
        ranges,
        signal: request.signal,
      });
      if (settlement.kind === "Cancelled") {
        throw cancelled("Conversation Find preview was cancelled.");
      }
      if (previewGeneration !== generation) {
        throw cancelled("Conversation Find preview was invalidated.");
      }
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      highlightOwner.publish({ all: allRanges(), active: ranges });
      origin ??= candidateOrigin;
      return {
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      };
    },
    async clearPresentation(request) {
      if (
        !disposed &&
        request.sourceKey === snapshot.sourceKey &&
        request.sourceKey === getCurrentSourceKey()
      ) {
        highlightOwner.clear();
        getScrollHandle()?.clearFindPresentation();
      }
    },
    async returnToReadingPosition(request) {
      assertCurrent(request.sourceKey);
      throwIfAborted(request.signal);
      if (!origin) return;
      const savedOrigin = origin;
      highlightOwner.clear();
      scrollHandle().restoreReadingPosition(savedOrigin);
      origin = null;
    },
    errorMessage: conversationFindErrorMessage,
    invalidate,
    dispose() {
      if (disposed) return;
      invalidate();
      disposed = true;
    },
  };
}

export function useConversationPaneFind({
  conversationId,
  activeLeafMessageId,
  messages,
  scrollRef,
}: {
  readonly conversationId: string | null;
  readonly activeLeafMessageId: string | null;
  readonly messages: readonly ConversationMessage[];
  readonly scrollRef: RefObject<ChatScrollHandle | null>;
}): ConversationPaneFindController {
  const candidate = createConversationFindSnapshot({
    conversationId,
    activeLeafMessageId,
    messages,
    sourceRevision: 0,
  });
  const [committedSnapshot, setCommittedSnapshot] = useState(candidate);
  let snapshot = committedSnapshot;
  if (candidate.sourceKey !== committedSnapshot.sourceKey) {
    snapshot = {
      ...candidate,
      sourceRevision: committedSnapshot.sourceRevision + 1,
    };
    setCommittedSnapshot(snapshot);
  }

  const currentSourceKeyRef = useRef(committedSnapshot.sourceKey);
  const highlightOwner = useMemo(
    () => createPaneFindHighlightOwner(),
    [],
  );
  const adapter = useMemo(
    () =>
      createConversationFindAdapter({
        snapshot,
        getCurrentSourceKey: () => currentSourceKeyRef.current,
        getScrollHandle: () => scrollRef.current,
        highlightOwner,
      }),
    [highlightOwner, scrollRef, snapshot],
  );
  const capability = useMemo(
    () => ({ kind: "Available" as const, adapter }),
    [adapter],
  );
  const paneFind = usePaneFind({ capability });
  const mountedAdapterRef = useRef<ConversationFindAdapter | null>(null);
  useLayoutEffect(() => {
    currentSourceKeyRef.current = snapshot.sourceKey;
    mountedAdapterRef.current = adapter;
    return () => {
      adapter.invalidate();
      if (mountedAdapterRef.current === adapter) {
        mountedAdapterRef.current = null;
      }
      queueMicrotask(() => {
        if (mountedAdapterRef.current !== adapter) {
          adapter.dispose();
        }
      });
    };
  }, [adapter, snapshot.sourceKey]);
  if (paneFind.kind !== "Available") {
    throw new Error("Conversation Pane Find capability must be available.");
  }
  return { ...paneFind.controller, sourceKey: snapshot.sourceKey };
}
