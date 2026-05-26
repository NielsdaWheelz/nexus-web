"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { retryMediaMetadata, retryMediaSource } from "@/lib/media/retryClient";

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
  onProcessingRestarted: (options: { resetRefreshSource: boolean }) => void;
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
      await retryMediaSource(media.id);
      onProcessingRestarted({ resetRefreshSource: false });
      feedback.show({
        severity: "success",
        title: "Processing retry started.",
      });
    } catch (err) {
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
      await apiFetch(`/api/media/${media.id}/refresh`, { method: "POST" });
      onProcessingRestarted({ resetRefreshSource: true });
      feedback.show({ severity: "success", title: "Source refresh started." });
    } catch (err) {
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
