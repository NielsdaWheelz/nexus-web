"use client";

import { useCallback, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { useResource } from "@/lib/api/useResource";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import type { ReaderHighlightChatIntent } from "@/lib/conversations/readerHighlightChatIntent";
import {
  decodeReaderSelectionPreview,
  type ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";

function hydrationErrorMessage(error: ApiError): FeedbackContent {
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_CONVERSATION_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: "This quote is no longer available.",
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title: "You don’t have access to this chat.",
        requestId: error.requestId,
      };
    case "E_NETWORK":
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: "This quote couldn’t be loaded.",
      };
    default:
      throw error;
  }
}

/** Map hydration failures onto the composer's one pending-context projection. */
function mapHydrationError(
  error: unknown,
  intent: ReaderHighlightChatIntent,
): PendingTurnContext {
  if (isApiError(error)) {
    switch (error.code) {
      case "E_READER_SELECTION_FORBIDDEN":
        return { kind: "NonSendable", intent, reason: "Forbidden" };
      case "E_READER_SELECTION_GEOMETRY_ONLY":
        return { kind: "NonSendable", intent, reason: "GeometryOnly" };
      case "E_READER_SELECTION_TOO_LARGE":
        return { kind: "NonSendable", intent, reason: "TooLarge" };
      case "E_READER_SELECTION_NOT_FOUND": {
        // justify-ignore-error: a not-found for a client-accepted launch is a
        // reported invariant defect (projection drift), never a NonSendable.
        console.error(
          "Reader-selection projection drift: highlight not found for an accepted launch",
          intent.selection,
        );
        return {
          kind: "LoadFailed",
          intent,
          error: {
            tone: "Danger",
            title: "This quote is temporarily unavailable.",
            message:
              "Its highlight hasn't finished syncing yet. Retry the quote to try again.",
            requestId: error.requestId,
          },
        };
      }
      case "E_INVALID_RESPONSE":
        throw error;
    }
  }
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return { kind: "LoadFailed", intent, error: hydrationErrorMessage(error) };
}

interface PendingReaderSelection {
  pendingContext: Presence<PendingTurnContext>;
  retryHydration: () => void;
}

/** Hydrate one canonical reader-selection launch intent for the composer. */
export function usePendingReaderSelection(
  intent: ReaderHighlightChatIntent | null,
): PendingReaderSelection {
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const selectionResource = useResource<ReaderSelectionPreview>({
    cacheKey: intent
      ? `chat-reader-selection:${intent.selection.mediaId}:${intent.selection.highlightId}:${refreshGeneration}`
      : null,
    load: async (signal) => {
      if (intent === null) {
        throw new Error("Cannot load a reader selection without an intent");
      }
      const response = await apiFetch<{ data: unknown }>(
        `/api/chat-reader-selections/highlights/${intent.selection.highlightId}?${new URLSearchParams(
          { media_id: intent.selection.mediaId },
        )}` as ApiPath,
        { signal },
      );
      const preview = decodeReaderSelectionPreview(response.data);
      if (preview === null) {
        throw new ApiError(
          200,
          "E_INVALID_RESPONSE",
          "Reader-selection preview response is invalid",
        );
      }
      return preview;
    },
  });
  let pendingContext: Presence<PendingTurnContext>;
  if (intent === null) {
    pendingContext = absent();
  } else {
    switch (selectionResource.status) {
      case "idle":
      case "loading":
        pendingContext = present({ kind: "Loading", intent });
        break;
      case "ready":
        pendingContext = present({
          kind: "ReaderHighlight",
          preview: selectionResource.data,
        });
        break;
      case "error":
        pendingContext = present(
          mapHydrationError(selectionResource.error, intent),
        );
        break;
      default: {
        const exhaustive: never = selectionResource;
        throw new Error(`Unexpected reader selection resource: ${exhaustive}`);
      }
    }
  }

  const retryHydration = useCallback(() => {
    setRefreshGeneration((generation) => generation + 1);
  }, []);
  return { pendingContext, retryHydration };
}
