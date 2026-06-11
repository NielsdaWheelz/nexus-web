"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquare, RefreshCw, Sparkles } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { toReaderCitationData } from "@/lib/conversations/citations";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import {
  dispatchReaderSourceActivation,
  hrefForReaderSourceTarget,
} from "@/lib/conversations/readerSourceActivation";
import { formatDisplayDate } from "@/lib/display/format";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useLibraryIntelligenceStream } from "@/components/library/useLibraryIntelligenceStream";
import styles from "./page.module.css";

type ArtifactStatus =
  | "unavailable"
  | "building"
  | "failed"
  | "stale"
  | "current";

interface LibraryIntelligenceBuild {
  revision_id: string;
  status: "building" | "ready" | "failed";
}

interface LibraryIntelligenceArtifact {
  artifact_id: string | null;
  revision_id: string | null;
  status: ArtifactStatus;
  content_md: string;
  citations: CitationOut[];
  stale_source_count: number | null;
  build: LibraryIntelligenceBuild | null;
}

interface RevisionSummary {
  revision_id: string;
  status: "building" | "ready" | "failed";
  created_at: string;
  promoted_at: string | null;
  is_current: boolean;
}

export default function LibraryIntelligencePane({
  libraryId,
  onOpenChat,
}: {
  libraryId: string;
  onOpenChat: (artifactId: string) => void;
}) {
  const display = useRenderEnvironment();
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);

  const reload = useCallback(() => {
    // justify: single refetch on terminal SSE event, not polling
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  const handleDone = useCallback(
    (_revisionId: string, doneError: string | null) => {
      if (doneError !== null) {
        setError({ severity: "error", title: "Generation failed" });
      }
      reload();
    },
    [reload],
  );

  const handleStreamError = useCallback((streamError: Error) => {
    setError(
      toFeedback(streamError, {
        fallback: "Library intelligence stream failed",
      }),
    );
  }, []);

  const { building, progress, generate, subscribe } =
    useLibraryIntelligenceStream({
      libraryId,
      onDone: handleDone,
      onError: handleStreamError,
    });

  const artifactResource = useResource<{ data: LibraryIntelligenceArtifact }>({
    cacheKey: `library-intelligence:${libraryId}:${reloadNonce}`,
    path: () => `/api/libraries/${libraryId}/intelligence`,
  });

  const artifact =
    artifactResource.status === "ready" ? artifactResource.data.data : null;

  // Resume an in-flight build (e.g. opened mid-generation): subscribe to the
  // draft revision's stream when the GET reports a building draft. The hook
  // itself dedupes a repeat subscribe to the same revision id.
  const inFlightRevisionId =
    artifact?.status === "building" ? artifact.build?.revision_id ?? null : null;
  useEffect(() => {
    if (inFlightRevisionId !== null) {
      void subscribe(inFlightRevisionId);
    }
  }, [inFlightRevisionId, subscribe]);

  const citations = useMemo(
    () => (artifact ? artifact.citations.map(toReaderCitationData) : []),
    [artifact],
  );

  const activate = useCallback(
    (target: ReaderSourceTarget, event?: React.MouseEvent) => {
      dispatchReaderSourceActivation(target);
      const href = hrefForReaderSourceTarget(target);
      if (event?.shiftKey) {
        openInNewPane?.(href, target.label);
        return;
      }
      router.push(href);
    },
    [openInNewPane, router],
  );

  const handleGenerate = useCallback(() => {
    setError(null);
    void generate();
  }, [generate]);

  if (artifactResource.status === "loading" && !artifact) {
    return <PaneLoadingState label="Loading intelligence…" />;
  }

  if (artifactResource.status === "error") {
    return (
      <div className={styles.intelligencePane}>
        <FeedbackNotice
          {...toFeedback(artifactResource.error, {
            fallback: "Failed to load library intelligence",
          })}
        />
      </div>
    );
  }

  if (!artifact) {
    return <PaneLoadingState label="Loading intelligence…" />;
  }

  const artifactId = artifact.artifact_id;
  // The status reflects the head; a live SSE build overrides a stale/current
  // head so the in-flight regenerate shows "Generating…" immediately.
  const status: ArtifactStatus = building ? "building" : artifact.status;
  const hasContent = artifact.content_md.trim().length > 0;

  return (
    <div className={styles.intelligencePane}>
      <div className={styles.intelligenceHeader}>
        <div className={styles.intelligenceTitleGroup}>
          <h2 className={styles.intelligenceTitle}>Intelligence</h2>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => artifactId && onOpenChat(artifactId)}
          disabled={artifactId === null}
          leadingIcon={<MessageSquare size={16} aria-hidden="true" />}
        >
          Chat
        </Button>
      </div>

      {error ? <FeedbackNotice {...error} /> : null}

      <StatusLine
        status={status}
        progress={progress}
        staleSourceCount={artifact.stale_source_count}
        building={building}
        onGenerate={handleGenerate}
      />

      {status === "unavailable" && !hasContent ? (
        <FeedbackNotice
          severity="neutral"
          title="No intelligence has been generated yet."
        />
      ) : hasContent ? (
        <div className={styles.intelligenceBody}>
          <MarkdownMessage
            content={artifact.content_md}
            citations={citations}
            onCitationActivate={activate}
          />
        </div>
      ) : null}

      {artifactId ? (
        <RevisionHistory
          libraryId={libraryId}
          display={display}
          onRestored={reload}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function StatusLine({
  status,
  progress,
  staleSourceCount,
  building,
  onGenerate,
}: {
  status: ArtifactStatus;
  progress: string | null;
  staleSourceCount: number | null;
  building: boolean;
  onGenerate: () => void;
}) {
  switch (status) {
    case "current":
      return (
        <div className={styles.intelligenceStatusLine} data-status="current">
          <span className={styles.intelligenceStatusLabel}>Current</span>
        </div>
      );
    case "stale":
      return (
        <div
          className={styles.intelligenceStatusLine}
          data-status="stale"
          role="status"
        >
          <span className={styles.intelligenceStatusLabel}>
            {`Stale — ${staleSourceCount} ${
              staleSourceCount === 1 ? "source" : "sources"
            } changed`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onGenerate}
            disabled={building}
            leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
          >
            Regenerate
          </Button>
        </div>
      );
    case "building":
      return (
        <div
          className={styles.intelligenceStatusLine}
          data-status="building"
          role="status"
        >
          <span className={styles.intelligenceStatusLabel}>
            {progress ? `Generating… ${progress}` : "Generating…"}
          </span>
        </div>
      );
    case "failed":
      return (
        <div
          className={styles.intelligenceStatusLine}
          data-status="failed"
          role="alert"
        >
          <span className={styles.intelligenceStatusLabel}>Failed</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onGenerate}
            disabled={building}
            leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
          >
            Retry
          </Button>
        </div>
      );
    case "unavailable":
      return (
        <div className={styles.intelligenceStatusLine} data-status="unavailable">
          <Button
            variant="primary"
            size="sm"
            onClick={onGenerate}
            disabled={building}
            leadingIcon={<Sparkles size={16} aria-hidden="true" />}
          >
            Generate
          </Button>
        </div>
      );
  }
  const _exhaustive: never = status;
  return _exhaustive;
}

function RevisionHistory({
  libraryId,
  display,
  onRestored,
  onError,
}: {
  libraryId: string;
  display: ReturnType<typeof useRenderEnvironment>;
  onRestored: () => void;
  onError: (feedback: FeedbackContent) => void;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch<{ data: { revisions: RevisionSummary[] } }>(
        `/api/libraries/${libraryId}/intelligence/revisions`,
      );
      setRevisions(response.data.revisions);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      onError(toFeedback(err, { fallback: "Failed to load revision history" }));
    } finally {
      setLoading(false);
    }
  }, [libraryId, onError]);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next && revisions === null && !loading) {
        void loadRevisions();
      }
      return next;
    });
  }, [loadRevisions, loading, revisions]);

  const restore = useCallback(
    async (revisionId: string) => {
      setRestoringId(revisionId);
      try {
        await apiFetch(
          `/api/libraries/${libraryId}/intelligence/revisions/${revisionId}/promote`,
          { method: "POST" },
        );
        onRestored();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        onError(toFeedback(err, { fallback: "Failed to restore revision" }));
      } finally {
        setRestoringId(null);
      }
    },
    [libraryId, onError, onRestored],
  );

  return (
    <div className={styles.intelligenceHistory}>
      <button
        type="button"
        className={styles.intelligenceHistoryToggle}
        aria-expanded={open}
        onClick={toggle}
      >
        History
      </button>
      {open ? (
        loading ? (
          <PaneLoadingState label="Loading history…" />
        ) : revisions && revisions.length > 0 ? (
          <ul className={styles.intelligenceHistoryList}>
            {revisions.map((revision) => (
              <li
                key={revision.revision_id}
                className={styles.intelligenceHistoryItem}
              >
                <span className={styles.intelligenceHistoryMeta}>
                  {formatDisplayDate(revision.created_at, display, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }) ?? revision.created_at}
                  {" · "}
                  {revision.status}
                  {revision.is_current ? (
                    <span className={styles.intelligenceHistoryBadge}>
                      Current
                    </span>
                  ) : null}
                </span>
                {!revision.is_current && revision.status === "ready" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void restore(revision.revision_id)}
                    disabled={restoringId !== null}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.intelligenceHistoryEmpty}>No revisions yet.</p>
        )
      ) : null}
    </div>
  );
}
