"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import {
  type MediaActionCapabilities,
  retryMediaMetadata,
} from "@/lib/media/ingestionClient";
import type { DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";

interface DocumentDeleteResponse {
  data: {
    status: "deleted" | "removed" | "hidden";
    hard_deleted: boolean;
    removed_from_library_ids?: string[];
    hidden_for_viewer?: boolean;
    remaining_reference_count?: number;
  };
}

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
}

export function useDocumentActions({
  media,
  onProcessingRestarted,
  onMetadataRetryEnqueued,
}: UseDocumentActionsOptions): DocumentActions {
  const router = usePaneRouter();
  const feedback = useFeedback();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [retryMetadataBusy, setRetryMetadataBusy] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!media || deleteBusy) {
      return;
    }
    if (
      !window.confirm(
        `Delete "${media.title}" from My Library and libraries you manage? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleteBusy(true);
    try {
      await apiFetch<DocumentDeleteResponse>(`/api/media/${media.id}`, {
        method: "DELETE",
      });
      router.push("/libraries");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to delete document" }),
      });
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, feedback, media, router]);

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
      feedback.show(projection.feedback);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to retry processing" }),
      });
    } finally {
      setRetryBusy(false);
    }
  }, [feedback, media, onProcessingRestarted, retryBusy]);

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
      feedback.show(projection.feedback);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to refresh source" }),
      });
    } finally {
      setRefreshBusy(false);
    }
  }, [feedback, media, onProcessingRestarted, refreshBusy]);

  const handleRetryMetadata = useCallback(async () => {
    if (!media || retryMetadataBusy) {
      return;
    }
    if (!media.capabilities?.can_retry_metadata) {
      feedback.show({
        severity: "warning",
        title: "Only the creator can re-enrich metadata.",
      });
      return;
    }
    setRetryMetadataBusy(true);
    try {
      await retryMediaMetadata(media.id);
      onMetadataRetryEnqueued?.();
      feedback.show({
        severity: "success",
        title: "Metadata re-enrichment started.",
      });
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      feedback.show({
        ...toFeedback(err, { fallback: "Failed to re-enrich metadata" }),
      });
    } finally {
      setRetryMetadataBusy(false);
    }
  }, [feedback, media, onMetadataRetryEnqueued, retryMetadataBusy]);

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
