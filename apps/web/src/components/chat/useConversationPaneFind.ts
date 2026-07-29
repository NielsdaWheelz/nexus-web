"use client";

import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { ConversationMessage } from "@/lib/conversations/types";
import {
  createConversationFindSnapshot,
  findConversationOccurrences,
  type ConversationFindOccurrence,
  type ConversationFindSnapshot,
} from "@/lib/conversations/conversationFind";
import type { PaneFindSourceKey } from "@/lib/panes/paneSearch";
import {
  usePaneFind,
  type PaneFindAdapter,
  type PaneFindController,
  type PaneFindPreviewReceipt,
  type PaneFindResponse,
} from "@/lib/panes/usePaneFind";
import type {
  ChatReadingPosition,
  ChatScrollHandle,
} from "@/components/chat/useChatScroll";

const ENTIRE_CONVERSATION_SCOPE_ID = "EntireConversation";

export type ConversationFindError =
  | { readonly kind: "StaleSource" }
  | { readonly kind: "OccurrenceUnavailable" }
  | { readonly kind: "OriginUnavailable" };

export interface ConversationPaneFindController extends PaneFindController {
  readonly sourceKey: PaneFindSourceKey;
}

function conversationFindErrorMessage(error: ConversationFindError): string {
  switch (error.kind) {
    case "StaleSource":
      return "The conversation changed. Try your search again.";
    case "OccurrenceUnavailable":
      return "That match is no longer available.";
    case "OriginUnavailable":
      return "Your reading position could not be captured.";
  }
}

export function createConversationFindAdapter({
  snapshot,
  getCurrentSourceKey,
  getScrollHandle,
}: {
  readonly snapshot: ConversationFindSnapshot;
  readonly getCurrentSourceKey: () => PaneFindSourceKey;
  readonly getScrollHandle: () => ChatScrollHandle | null;
}): PaneFindAdapter<ConversationFindError> {
  let occurrencesByKey = new Map<string, ConversationFindOccurrence>();
  let origin: ChatReadingPosition | null = null;

  const isCurrent = (sourceKey: PaneFindSourceKey) =>
    sourceKey === snapshot.sourceKey &&
    sourceKey === getCurrentSourceKey();
  const failed = ({
    request,
    error,
  }: {
    readonly request: {
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
    };
    readonly error: ConversationFindError;
  }): PaneFindResponse<ConversationFindError> => ({
    kind: "Failed",
    sessionId: request.sessionId,
    queryId: request.queryId,
    sourceKey: request.sourceKey,
    error,
  });
  const rejected = ({
    request,
    error,
  }: {
    readonly request: {
      readonly sessionId: number;
      readonly queryId: number;
      readonly sourceKey: PaneFindSourceKey;
      readonly key: Parameters<PaneFindAdapter<ConversationFindError>["preview"]>[0]["key"];
    };
    readonly error: ConversationFindError;
  }): PaneFindPreviewReceipt<ConversationFindError> => ({
    kind: "Rejected",
    sessionId: request.sessionId,
    queryId: request.queryId,
    sourceKey: request.sourceKey,
    key: request.key,
    error,
  });

  return {
    sourceKey: snapshot.sourceKey,
    async prepare(request) {
      return {
        sessionId: request.sessionId,
        sourceKey: request.sourceKey,
        scopes: [
          {
            kind: "EntireResource",
            id: ENTIRE_CONVERSATION_SCOPE_ID,
            label: "Entire conversation",
          },
        ],
      };
    },
    async find(request) {
      if (!isCurrent(request.sourceKey)) {
        return failed({ request, error: { kind: "StaleSource" } });
      }
      if (request.scopeId !== ENTIRE_CONVERSATION_SCOPE_ID) {
        throw new Error(`Unknown Conversation Find scope: ${request.scopeId}`);
      }
      const matches = findConversationOccurrences({
        snapshot,
        query: request.query,
        matchCase: request.matchCase,
        wholeWord: request.wholeWord,
      });
      switch (matches.kind) {
        case "NoMatches":
          occurrencesByKey = new Map();
          return {
            kind: "NoMatches",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            completeness: "Complete",
          };
        case "TooManyMatches":
          occurrencesByKey = new Map();
          return {
            kind: "TooManyMatches",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            threshold: matches.threshold,
          };
        case "Ready":
          occurrencesByKey = new Map(
            matches.occurrences.map((occurrence) => [
              occurrence.key,
              occurrence,
            ]),
          );
          return {
            kind: "Ready",
            sessionId: request.sessionId,
            queryId: request.queryId,
            sourceKey: request.sourceKey,
            completeness: "Complete",
            rows: matches.occurrences.map((occurrence) => occurrence.row),
          };
      }
    },
    async preview(request) {
      if (!isCurrent(request.sourceKey)) {
        return rejected({ request, error: { kind: "StaleSource" } });
      }
      const occurrence = occurrencesByKey.get(request.key);
      const scroll = getScrollHandle();
      if (!occurrence || !scroll) {
        return rejected({
          request,
          error: { kind: "OccurrenceUnavailable" },
        });
      }
      const candidateOrigin = origin ?? scroll.captureReadingPosition();
      if (!candidateOrigin) {
        return rejected({ request, error: { kind: "OriginUnavailable" } });
      }
      const previewed = await scroll.previewFindOccurrence({
        occurrence: {
          messageId: occurrence.messageId,
          blockIndex: occurrence.blockIndex,
          start: occurrence.start,
          end: occurrence.end,
        },
        signal: request.signal,
      });
      if (!previewed) {
        return rejected({
          request,
          error: { kind: "OccurrenceUnavailable" },
        });
      }
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
      if (isCurrent(request.sourceKey)) {
        getScrollHandle()?.clearFindPresentation();
      }
    },
    async returnToReadingPosition(request) {
      if (!isCurrent(request.sourceKey)) return;
      if (!origin) return;
      const scroll = getScrollHandle();
      if (!scroll || !scroll.restoreReadingPosition(origin)) {
        throw new Error("Conversation Find return origin is no longer renderable.");
      }
      origin = null;
    },
    errorMessage: conversationFindErrorMessage,
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
  const snapshot = useMemo(
    () =>
      createConversationFindSnapshot({
        conversationId,
        activeLeafMessageId,
        messages,
      }),
    [activeLeafMessageId, conversationId, messages],
  );
  const currentSourceKeyRef = useRef(snapshot.sourceKey);
  currentSourceKeyRef.current = snapshot.sourceKey;
  const adapter = useMemo(
    () =>
      createConversationFindAdapter({
        snapshot,
        getCurrentSourceKey: () => currentSourceKeyRef.current,
        getScrollHandle: () => scrollRef.current,
      }),
    [scrollRef, snapshot],
  );
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    scroll?.clearFindPresentation();
    return () => scroll?.clearFindPresentation();
  }, [scrollRef, snapshot.sourceKey]);
  return { ...usePaneFind({ adapter }), sourceKey: snapshot.sourceKey };
}
