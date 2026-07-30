"use client";

import { useCallback } from "react";
import { toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
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
  // Busy key for add/remove: `${libraryId}:${podcastId}`.
  const busyLibraryPlacementKeys = useStringIdSet();
  const refreshingPodcastIds = useStringIdSet();
  const unsubscribingPodcastIds = useStringIdSet();

  const loadLibraries = useCallback(
    async (podcastId: string): Promise<LibraryPlacementOption[] | null> => {
      try {
        return await listLibraryPlacements({ kind: "Podcast", id: podcastId });
      } catch (loadError) {
        if (handleUnauthenticatedApiError(loadError)) return null;
        if (!isApiError(loadError) || isSameSystemApiDefect(loadError)) {
          throw loadError;
        }
        onError(
          toFeedback(loadError, { fallback: "Failed to load podcast libraries" }),
        );
        return null;
      }
    },
    [onError],
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
        );
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        if (!isApiError(mutationError) || isSameSystemApiDefect(mutationError)) {
          throw mutationError;
        }
        onError(
          toFeedback(mutationError, {
            fallback: "Failed to add podcast to library",
          }),
        );
      } finally {
        busyLibraryPlacementKeys.remove(busyKey);
      }
    },
    [busyLibraryPlacementKeys, onError],
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
        );
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        if (!isApiError(mutationError) || isSameSystemApiDefect(mutationError)) {
          throw mutationError;
        }
        onError(
          toFeedback(mutationError, {
            fallback: "Failed to remove podcast from library",
          }),
        );
      } finally {
        busyLibraryPlacementKeys.remove(busyKey);
      }
    },
    [busyLibraryPlacementKeys, onError],
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
        if (!isApiError(refreshError) || isSameSystemApiDefect(refreshError)) {
          throw refreshError;
        }
        onError(
          toFeedback(refreshError, {
            fallback: "Failed to check for new episodes",
          }),
        );
      } finally {
        refreshingPodcastIds.remove(podcastId);
      }
    },
    [onError, refreshingPodcastIds],
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
        if (
          !isApiError(unsubscribeError) ||
          isSameSystemApiDefect(unsubscribeError)
        ) {
          throw unsubscribeError;
        }
        onError(
          toFeedback(unsubscribeError, {
            fallback: "Failed to unsubscribe from podcast",
          }),
        );
        return false;
      } finally {
        unsubscribingPodcastIds.remove(podcastId);
      }
    },
    [loadLibraries, onError, unsubscribingPodcastIds],
  );

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
