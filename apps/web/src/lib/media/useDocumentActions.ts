"use client";

import { useCallback, useState } from "react";
import {
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import {
  type MediaActionCapabilities,
  retryMediaMetadata,
} from "@/lib/media/ingestionClient";
import type { DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { confirmAndDeleteMedia } from "@/lib/media/mediaLibraries";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";

interface DocumentActionTarget {
  id: string;
  title: string;
  capabilities?: {
    can_retry?: boolean;
    can_refresh_source?: boolean;
    can_retry_metadata?: boolean;
  };
}

interface DocumentActions {
  deleteBusy: boolean;
  retryBusy: boolean;
  refreshBusy: boolean;
  retryMetadataBusy: boolean;
  handleDelete: () => Promise<void>;
  handleRetry: () => Promise<void>;
  handleRefresh: () => Promise<void>;
  handleRetryMetadata: () => Promise<void>;
}

interface UseDocumentActionsOptions {
  media: DocumentActionTarget | null;
  /** Called after a retry/refresh API call succeeds; component resets its local content state. */
  onProcessingRestarted: (options: {
    resetRefreshSource: boolean;
    processingStatus: DocumentProcessingStatus;
    sourceFailed: boolean;
    capabilityPatch: MediaActionCapabilities;
  }) => void;
  onMetadataRetryEnqueued?: () => void;
  metadataRetryBlocked: boolean;
  onMetadataRetryUnconfirmed: (content: FeedbackContent) => void;
}

type MediaActionOperation = "Delete" | "Retry" | "Refresh" | "RetryMetadata";

function mediaActionTitle(operation: MediaActionOperation): string {
  switch (operation) {
    case "Delete":
      return "Media wasn’t removed";
    case "Retry":
      return "Processing retry wasn’t started";
    case "Refresh":
      return "Source refresh wasn’t started";
    case "RetryMetadata":
      return "Metadata enrichment wasn’t started";
  }
}

/** Finite copy adapter for user-started media mutation endpoints. */
function mediaActionErrorMessage(
  error: ApiError,
  operation: MediaActionOperation,
): FeedbackContent {
  if (isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = mediaActionTitle(operation);
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
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available. Return to your library.",
        requestId,
      };
    case "E_MEDIA_NOT_READY":
      if (operation === "Delete") throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is still preparing. Wait for it to settle, then retry.",
        requestId,
      };
    case "E_RETRY_INVALID_STATE":
      if (operation === "Delete") throw error;
      return {
        tone: "Danger",
        title,
        message:
          operation === "RetryMetadata"
            ? "Metadata can be retried only after this item is ready to read."
            : "The source state changed. Review its current status before trying again.",
        requestId,
      };
    case "E_RETRY_NOT_ALLOWED":
      if (operation === "Delete" || operation === "RetryMetadata") throw error;
      return {
        tone: "Danger",
        title,
        message:
          operation === "Retry"
            ? "This source can’t be retried. Add a new source instead."
            : "This source can’t be refreshed. Add a new source instead.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t make that change.",
        requestId,
      };
    default:
      throw error;
  }
}

export function useDocumentActions({
  media,
  onProcessingRestarted,
  onMetadataRetryEnqueued,
  metadataRetryBlocked,
  onMetadataRetryUnconfirmed,
}: UseDocumentActionsOptions): DocumentActions {
  const router = usePaneRouter();
  const feedback = useFeedback();
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [retryMetadataBusy, setRetryMetadataBusy] = useState(false);
  const reportActionError = useCallback(
    (error: ApiError, operation: MediaActionOperation, key: string) => {
      try {
        feedback.publish({
          kind: "Hud",
          key,
          content: mediaActionErrorMessage(error, operation),
        });
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
    },
    [feedback],
  );

  const handleDelete = useCallback(async () => {
    if (!media || deleteBusy) {
      return;
    }
    setDeleteBusy(true);
    try {
      const outcome = await confirmAndDeleteMedia({
        mediaId: media.id,
        mediaTitle: media.title,
        confirmRemoval: (message) => window.confirm(message),
      });
      if (outcome.kind === "Cancelled") return;
      router.push("/libraries");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      reportActionError(err, "Delete", `media-delete:${media.id}`);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, media, reportActionError, router]);

  const handleRetry = useCallback(async () => {
    if (!media || retryBusy || !media.capabilities?.can_retry) {
      return;
    }
    setRetryBusy(true);
    try {
      const projection = await runSourceProcessingAction({
        mediaId: media.id,
        action: "retry",
        successTitle: "Processing retry started.",
        failedTitle: "Retry request failed after it was saved.",
      });
      onProcessingRestarted({
        resetRefreshSource: projection.resetRefreshSource,
        processingStatus: projection.processingStatus,
        sourceFailed: projection.sourceFailed,
        capabilityPatch: projection.capabilityPatch,
      });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      reportActionError(err, "Retry", `media-retry:${media.id}`);
    } finally {
      setRetryBusy(false);
    }
  }, [media, onProcessingRestarted, reportActionError, retryBusy]);

  const handleRefresh = useCallback(async () => {
    if (!media || refreshBusy || !media.capabilities?.can_refresh_source) {
      return;
    }
    setRefreshBusy(true);
    try {
      const projection = await runSourceProcessingAction({
        mediaId: media.id,
        action: "refresh",
        successTitle: "Source refresh started.",
        failedTitle: "Refresh request failed after it was saved.",
      });
      onProcessingRestarted({
        resetRefreshSource: projection.resetRefreshSource,
        processingStatus: projection.processingStatus,
        sourceFailed: projection.sourceFailed,
        capabilityPatch: projection.capabilityPatch,
      });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      reportActionError(err, "Refresh", `media-refresh:${media.id}`);
    } finally {
      setRefreshBusy(false);
    }
  }, [media, onProcessingRestarted, refreshBusy, reportActionError]);

  const handleRetryMetadata = useCallback(async () => {
    if (!media || retryMetadataBusy || metadataRetryBlocked) {
      return;
    }
    if (!media.capabilities?.can_retry_metadata) {
      return;
    }
    setRetryMetadataBusy(true);
    try {
      await retryMediaMetadata(media.id);
      onMetadataRetryEnqueued?.();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      if (
        isApiError(err) &&
        (err.code === "E_NETWORK" || err.code === "E_UPSTREAM_TIMEOUT")
      ) {
        onMetadataRetryUnconfirmed({
          tone: "Warning",
          title: "Metadata request couldn’t be confirmed",
          message: "Its status is being checked. Don’t start it again yet.",
          requestId: err.requestId,
        });
        return;
      }
      if (!isApiError(err) || isSameSystemApiDefect(err)) {
        setAsyncDefect({ error: err });
        return;
      }
      reportActionError(
        err,
        "RetryMetadata",
        `media-metadata-retry:${media.id}`,
      );
    } finally {
      setRetryMetadataBusy(false);
    }
  }, [
    media,
    metadataRetryBlocked,
    onMetadataRetryEnqueued,
    onMetadataRetryUnconfirmed,
    reportActionError,
    retryMetadataBusy,
  ]);

  if (asyncDefect !== null) throw asyncDefect.error;

  return {
    deleteBusy,
    retryBusy,
    refreshBusy,
    retryMetadataBusy,
    handleDelete,
    handleRetry,
    handleRefresh,
    handleRetryMetadata,
  };
}
