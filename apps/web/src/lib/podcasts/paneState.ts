"use client";

// The podcast domain's translator, ahead of transport: domain codes become reasons, and
// everything else is `transportOf`'s. Also the chrome's refresh over the shared server-state
// hooks (lib/api/serverState).

import { useCallback, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isRefusal,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { catalogLine } from "@/lib/catalog/copy";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import type { PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { requestPodcastRefresh, type PodcastRefreshScope } from "@/lib/podcasts/api";

/** Why the server refused a podcast command, when the code is the domain's; undefined leaves
 * the line to transport. */
export function podcastRefusalReason(error: ApiError): string | undefined {
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_PODCAST_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return "it isn’t available anymore.";
    case "E_PODCAST_SUBSCRIPTION_ACTIVE":
      return "a podcast subscription includes it.";
    case "E_PODCAST_FEED_UNAVAILABLE":
      return "its feed couldn’t be read.";
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return "the podcast directory isn’t answering.";
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return "the podcast directory is busy.";
    case "E_FORBIDDEN":
      return "this account can’t make that change.";
    case "E_RESOURCE_CONFLICT":
    case "E_CONFLICT":
    case "E_SELECTION_CHANGED":
      return "it changed meanwhile.";
    case "E_MEDIA_NOT_READY":
      return "it’s still being prepared.";
    default:
      return undefined;
  }
}

/** Coexistence until L7: collections (L5a), the metadata overlay (L2) and the browse preview
 * (L6) still read this shape. Throws defects. */
export function podcastErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const catalog = catalogLine(error);
  if (catalog !== null) return { tone: error.code === "E_CATALOG_COVERAGE" || error.code === "E_CATALOG_UNAVAILABLE" ? "Neutral" : "Warning", title: catalog.fact, message: catalog.reason };
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
    case "E_PODCAST_SUBSCRIPTION_ACTIVE":
      return content("included by this podcast subscription. unsubscribe before removing it.");
    case "E_PODCAST_FEED_UNAVAILABLE":
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return content("the source check could not be completed. retry later.");
    case "E_INVALID_DISCOVERY_TARGET":
      return content("this discovery link is invalid or obsolete.");
    case "E_FORBIDDEN":
      return content("This account can’t do that.");
    case "E_RESOURCE_CONFLICT":
    case "E_CONFLICT":
    case "E_SELECTION_CHANGED":
      return content("It changed meanwhile. Review it, then retry.");
    case "E_INVALID_REQUEST":
      return content("This view or request isn’t valid.");
    case "E_INVALID_CURSOR":
      return content("This list can no longer continue; retry to read it again.");
    case "E_MEDIA_NOT_READY":
      return content("It’s still preparing. Retry once it settles.");
    default:
      throw error;
  }
}

/** Coexistence until L7, for the browse preview (L6): one command at a time; its modeled failure
 * becomes `failure`. */
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

/** The pane chrome's refresh: admit; panes refetch on "Podcasts". Success says nothing. */
export function podcastRefresh(scope: PodcastRefreshScope): PaneRefreshExecute {
  return async ({ signal }) => {
    try {
      await requestPodcastRefresh(scope, signal);
      return null;
    } catch (error) {
      if (isAbortError(error) || !isApiError(error)) throw error;
      if (isSameSystemApiDefect(error)) throw error;
      handleUnauthenticatedApiError(error);
      return isRefusal(error)
        ? { kind: "Refused", error, fact: "couldn’t check for new episodes." }
        : { kind: "Unknown", fact: "not sure the episode check started." };
    }
  };
}
