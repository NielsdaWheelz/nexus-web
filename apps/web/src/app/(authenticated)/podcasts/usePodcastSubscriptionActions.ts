"use client";

import { useCallback } from "react";
import { toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  addPodcastToLibrary,
  buildPodcastUnsubscribeConfirmation,
  fetchPodcastLibraries,
  getPodcastSubscriptionSyncPatch,
  refreshPodcastSubscriptionSync,
  removePodcastFromLibrary,
  unsubscribeFromPodcast,
  type PodcastLibraryMembership,
  type PodcastSubscriptionSyncRefreshResult,
} from "./podcastSubscriptions";

/**
 * The shared network core of the five podcast-subscription handlers, used by
 * both the list pane (keyed by podcast id) and the detail pane (single
 * podcast). Each primitive owns its busy-state toggle and routes failures to
 * `onError`; the caller supplies the success bookkeeping (`onSuccess`) because
 * the two panes patch different local state shapes (row badges vs. scalar
 * subscription). Membership/refresh busy sets are owned here so callers read
 * them for disabled states.
 */
export function usePodcastSubscriptionActions(
  onError: (feedback: FeedbackContent) => void,
) {
  // Busy key for add/remove: `${libraryId}:${podcastId}`.
  const busyLibraryMembershipKeys = useStringIdSet();
  const refreshingPodcastIds = useStringIdSet();
  const unsubscribingPodcastIds = useStringIdSet();

  const loadLibraries = useCallback(
    async (podcastId: string): Promise<PodcastLibraryMembership[] | null> => {
      try {
        return await fetchPodcastLibraries(podcastId);
      } catch (loadError) {
        if (handleUnauthenticatedApiError(loadError)) return null;
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
      busyLibraryMembershipKeys.add(busyKey);
      try {
        await addPodcastToLibrary(podcastId, libraryId);
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        onError(
          toFeedback(mutationError, {
            fallback: "Failed to add podcast to library",
          }),
        );
      } finally {
        busyLibraryMembershipKeys.remove(busyKey);
      }
    },
    [busyLibraryMembershipKeys, onError],
  );

  const removeFromLibrary = useCallback(
    async (
      podcastId: string,
      libraryId: string,
      onSuccess: () => void,
    ): Promise<void> => {
      const busyKey = `${libraryId}:${podcastId}`;
      busyLibraryMembershipKeys.add(busyKey);
      try {
        await removePodcastFromLibrary(podcastId, libraryId);
        onSuccess();
      } catch (mutationError) {
        if (handleUnauthenticatedApiError(mutationError)) return;
        onError(
          toFeedback(mutationError, {
            fallback: "Failed to remove podcast from library",
          }),
        );
      } finally {
        busyLibraryMembershipKeys.remove(busyKey);
      }
    },
    [busyLibraryMembershipKeys, onError],
  );

  const refreshSync = useCallback(
    async (
      podcastId: string,
      onSuccess: (
        patch: ReturnType<typeof getPodcastSubscriptionSyncPatch>,
        result: PodcastSubscriptionSyncRefreshResult,
      ) => void,
    ): Promise<void> => {
      refreshingPodcastIds.add(podcastId);
      try {
        const result = await refreshPodcastSubscriptionSync(podcastId);
        onSuccess(getPodcastSubscriptionSyncPatch(result), result);
      } catch (refreshError) {
        if (handleUnauthenticatedApiError(refreshError)) return;
        onError(
          toFeedback(refreshError, { fallback: "Failed to refresh podcast sync" }),
        );
      } finally {
        refreshingPodcastIds.remove(podcastId);
      }
    },
    [onError, refreshingPodcastIds],
  );

  // Confirms (loading fresh library membership for the prompt) then unsubscribes.
  // `onSuccess` receives the freshly-loaded libraries so the caller can compute
  // retained (non-removable) libraries; returns false if the user cancels or the
  // library load fails.
  const unsubscribe = useCallback(
    async (
      podcastId: string,
      title: string,
      onSuccess: (libraries: PodcastLibraryMembership[]) => void,
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
        await unsubscribeFromPodcast(podcastId);
        onSuccess(libraries);
        return true;
      } catch (unsubscribeError) {
        if (handleUnauthenticatedApiError(unsubscribeError)) return false;
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
    busyLibraryMembershipKeys,
    refreshingPodcastIds,
    unsubscribingPodcastIds,
    loadLibraries,
    addToLibrary,
    removeFromLibrary,
    refreshSync,
    unsubscribe,
  };
}
