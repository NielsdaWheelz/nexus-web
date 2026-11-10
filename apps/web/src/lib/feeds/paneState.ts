"use client";

// The source domain's translator, ahead of transport: domain codes become reasons, and
// everything else is `transportOf`'s. Also the chrome's refresh over the shared server-state
// hooks (lib/api/serverState).


import {
  isApiError,
  isRefusal,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import type { PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { requestFeedRefresh, type FeedRefreshScope } from "@/lib/feeds/api";


/** Why the server refused a feed command, when the code is the domain's; undefined leaves
 * the line to transport. */
export function feedRefusalReason(error: ApiError): string | undefined {
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_FEED_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return "it isn’t available anymore.";
    case "E_FEED_SUBSCRIPTION_ACTIVE":
      return "a subscription includes it.";
    case "E_FEED_UNAVAILABLE":
      return "its feed couldn’t be read.";
    case "E_FEED_PRIVATE_SOURCE":
      return "this source doesn’t grant access to the existing article.";
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return "the podcast directory isn’t answering.";
    case "E_BROWSE_PROVIDER_RATE_LIMITED":
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return "the podcast directory is busy.";
    case "E_FORBIDDEN":
      return "this account can’t make that change.";
    case "E_SELECTION_CHANGED":
      return "it changed meanwhile.";
    case "E_MEDIA_NOT_READY":
      return "it’s still being prepared.";
    default:
      return undefined;
  }
}

/** The pane chrome's refresh: admit; panes refetch on "Feeds". Success says nothing. */
export function feedRefresh(scope: FeedRefreshScope, kind: "podcast" | "article" | null = null): PaneRefreshExecute {
  return async ({ signal }) => {
    try {
      await requestFeedRefresh(scope, signal);
      return null;
    } catch (error) {
      if (isAbortError(error) || !isApiError(error)) throw error;
      if (isSameSystemApiDefect(error)) throw error;
      handleUnauthenticatedApiError(error);
      return isRefusal(error)
        ? { kind: "Refused", error, fact: `couldn’t check for new ${kind === "podcast" ? "episodes" : kind === "article" ? "articles" : "items"}.` }
        : { kind: "Unknown", fact: "not sure the source check started." };
    }
  };
}
