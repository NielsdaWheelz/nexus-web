"use client";

import { useCallback, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  addLibraryPlacement,
  listLibraryPlacements,
  removeLibraryPlacement,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import { runPodcastRefresh } from "@/lib/podcasts/refresh";
import type { PodcastRefreshResult } from "@/lib/podcasts/types";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  buildPodcastUnsubscribeConfirmation,
  unsubscribeFromPodcast,
  type PodcastUnsubscribeResult,
} from "./podcastSubscriptions";

type PodcastSubscriptionOperation =
  | "LoadLibraries"
  | "AddToLibrary"
  | "RemoveFromLibrary"
  | "Refresh"
  | "Unsubscribe";

function podcastSubscriptionTitle(operation: PodcastSubscriptionOperation): string {
  switch (operation) {
    case "LoadLibraries":
      return "Podcast libraries couldn’t be loaded";
    case "AddToLibrary":
      return "Podcast wasn’t added to the library";
    case "RemoveFromLibrary":
      return "Podcast wasn’t removed from the library";
    case "Refresh":
      return "New episodes couldn’t be checked";
    case "Unsubscribe":
      return "Podcast wasn’t unsubscribed";
  }
}

/** Finite product-copy adapter for podcast subscription mutations. */
function podcastSubscriptionErrorMessage(
  error: unknown,
  operation: PodcastSubscriptionOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = podcastSubscriptionTitle(operation);
  switch (error.code) {
    case "E_NETWORK":
      return { tone: "Danger", title, message: "Check your connection and retry.", requestId };
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the action.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return { tone: "Danger", title, message: "Wait a moment, then retry.", requestId };
    case "E_CONFLICT":
      return {
        tone: "Danger",
        title,
        message: "The subscription changed. Refresh the pane, then retry.",
        requestId,
      };
    case "E_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
    case "E_LIBRARY_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "The podcast or library is no longer available. Refresh the pane.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t make that change.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title,
        message: "The subscription settings changed. Refresh the pane, then retry.",
        requestId,
      };
    default:
      throw error;
  }
}

/**
 * The shared network core of the five podcast-subscription handlers, used by
 * both the list pane (keyed by podcast id) and the detail pane (single
 * podcast). Each primitive owns its busy-state toggle and routes failures to
 * `onError`; the caller owns success bookkeeping and owner-level revalidation.
 * Membership and refresh busy sets are owned here so callers read them for
 * disabled states. Refresh observation borrows the pane owner's source-fenced
 * signal and stays busy until that owner's success callback commits.
 */
export function usePodcastSubscriptionActions(
  onError: (feedback: FeedbackContent) => void,
) {
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  // Busy key for add/remove: `${libraryId}:${podcastId}`.
  const busyLibraryPlacementKeys = useStringIdSet();
  const refreshingPodcastIds = useStringIdSet();
  const unsubscribingPodcastIds = useStringIdSet();
  const reportError = useCallback(
    (error: unknown, operation: PodcastSubscriptionOperation) => {
      try {
        onError(podcastSubscriptionErrorMessage(error, operation));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [onError],
  );

  const loadLibraries = useCallback(
    async (podcastId: string): Promise<LibraryPlacementOption[] | null> => {
      try {
        return await listLibraryPlacements({ kind: "Podcast", id: podcastId });
      } catch (loadError) {
        if (handleUnauthenticatedApiError(loadError)) return null;
        reportError(loadError, "LoadLibraries");
        return null;
      }
    },
    [reportError],
  );

  const addToLibrary = useCallback(
    async (
      podcastId: string,
      libraryId: string,
      onSuccess: () => void,
    ): Promise<void> => {
      const busyKey = `${libraryId}:${podcastId}`;
      busyLibraryPlacementKeys.add(busyKey);
      try {
        await addLibraryPlacement(
          { kind: "Podcast", id: podcastId },
          libraryId,
          { clientMutationId: crypto.randomUUID() },
        );
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        reportError(mutationError, "AddToLibrary");
      } finally {
        busyLibraryPlacementKeys.remove(busyKey);
      }
    },
    [busyLibraryPlacementKeys, reportError],
  );

  const removeFromLibrary = useCallback(
    async (
      podcastId: string,
      libraryId: string,
      onSuccess: () => void,
    ): Promise<void> => {
      const busyKey = `${libraryId}:${podcastId}`;
      busyLibraryPlacementKeys.add(busyKey);
      try {
        await removeLibraryPlacement(
          { kind: "Podcast", id: podcastId },
          libraryId,
          { clientMutationId: crypto.randomUUID() },
        );
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        reportError(mutationError, "RemoveFromLibrary");
      } finally {
        busyLibraryPlacementKeys.remove(busyKey);
      }
    },
    [busyLibraryPlacementKeys, reportError],
  );

  const checkForNewEpisodes = useCallback(
    async (
      podcastId: string,
      signal: AbortSignal,
      onSuccess: (
        result: PodcastRefreshResult,
        signal: AbortSignal,
      ) => void | Promise<void>,
    ): Promise<void> => {
      refreshingPodcastIds.add(podcastId);
      try {
        const result = await runPodcastRefresh(
          { kind: "Podcast", podcastId },
          {
            signal,
            onProgress: () => {},
          },
        );
        if (signal.aborted) return;
        await onSuccess(result, signal);
      } catch (refreshError) {
        if (isAbortError(refreshError)) return;
        if (handleUnauthenticatedApiError(refreshError)) return;
        reportError(refreshError, "Refresh");
      } finally {
        refreshingPodcastIds.remove(podcastId);
      }
    },
    [refreshingPodcastIds, reportError],
  );

  // Confirms (loading fresh library placement for the prompt) then unsubscribes.
  // `onSuccess` receives the freshly-loaded libraries so the caller can compute
  // retained (non-removable) libraries; returns false if the user cancels or the
  // library load fails.
  const unsubscribe = useCallback(
    async (
      podcastId: string,
      title: string,
      onSuccess: (
        libraries: LibraryPlacementOption[],
        result: PodcastUnsubscribeResult,
      ) => void,
    ): Promise<boolean> => {
      const libraries = await loadLibraries(podcastId);
      if (libraries === null) {
        return false;
      }
      if (
        !window.confirm(buildPodcastUnsubscribeConfirmation(title, libraries))
      ) {
        return false;
      }
      unsubscribingPodcastIds.add(podcastId);
      try {
        const result = await unsubscribeFromPodcast(podcastId);
        onSuccess(libraries, result);
        return true;
      } catch (unsubscribeError) {
        if (handleUnauthenticatedApiError(unsubscribeError)) return false;
        reportError(unsubscribeError, "Unsubscribe");
        return false;
      } finally {
        unsubscribingPodcastIds.remove(podcastId);
      }
    },
    [loadLibraries, reportError, unsubscribingPodcastIds],
  );

  if (asyncDefect !== null) throw asyncDefect.error;

  return {
    busyLibraryPlacementKeys,
    refreshingPodcastIds,
    unsubscribingPodcastIds,
    loadLibraries,
    addToLibrary,
    removeFromLibrary,
    checkForNewEpisodes,
    unsubscribe,
  };
}
