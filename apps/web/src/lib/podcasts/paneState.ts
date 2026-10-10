"use client";

// Podcast pane failure copy, one-at-a-time commands and the chrome refresh,
// over the shared server-state hooks (lib/api/serverState).

import { useCallback, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import type { PaneRefreshExecute } from "@/lib/panes/panePublications";
import {
  podcastRefreshRequestAnnouncement,
  requestPodcastRefresh,
  type PodcastRefreshScope,
} from "@/lib/podcasts/api";

/** Failure copy for podcast reads and commands; throws defects. */
export function podcastErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const transport = apiTransportFeedback(error, title);
  if (transport !== null) return transport;
  const content = (message: string): FeedbackContent => ({
    tone: "Danger",
    title,
    message,
    requestId: error.requestId,
  });
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return content("It isn’t available.");
    case "E_FORBIDDEN":
      return content("This account can’t do that.");
    case "E_CONFLICT":
    case "E_SELECTION_CHANGED":
    case "E_COLLECTION_CHANGED":
      return content("It changed meanwhile. Review it, then retry.");
    case "E_INVALID_REQUEST":
      return content("This view or request isn’t valid.");
    case "E_MEDIA_NOT_READY":
      return content("It’s still preparing. Retry once it settles.");
    default:
      throw error;
  }
}

/** One command at a time; its modeled failure becomes `failure`. */
export function useCommand(): {
  readonly running: string | null;
  readonly failure: FeedbackContent | null;
  readonly run: (title: string, command: () => Promise<void>) => void;
} {
  const fail = useThrowLater();
  const [running, setRunning] = useState<string | null>(null);
  const [failed, setFailed] = useState<{
    readonly title: string;
    readonly error: ApiError;
  } | null>(null);
  const busy = useRef(false);
  const run = useCallback(
    (title: string, command: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setRunning(title);
      setFailed(null);
      void command()
        .catch((error: unknown) => {
          const modeled = modeledApiError(error, fail);
          if (modeled !== null) setFailed({ title, error: modeled });
        })
        .finally(() => {
          busy.current = false;
          setRunning(null);
        });
    },
    [fail],
  );
  const failure =
    failed === null ? null : podcastErrorMessage(failed.error, failed.title);
  return { running, failure, run };
}

/** The pane chrome's refresh: admit, then announce; panes refetch on bump. */
export function podcastRefresh(scope: PodcastRefreshScope): PaneRefreshExecute {
  return async ({ signal }) => {
    try {
      const count = await requestPodcastRefresh(scope, signal);
      const announcement = podcastRefreshRequestAnnouncement(count);
      return { kind: "Complete", announcement };
    } catch (error) {
      if (isAbortError(error) || !isApiError(error)) throw error;
      if (isSameSystemApiDefect(error)) throw error;
      handleUnauthenticatedApiError(error);
      return { kind: "Failed", announcement: "Podcast refresh failed" };
    }
  };
}
