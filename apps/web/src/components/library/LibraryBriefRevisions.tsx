"use client";

import { useCallback, useState } from "react";
import Button from "@/components/ui/Button";
import { toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { formatDisplayDate } from "@/lib/display/format";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { RevisionSummary } from "@/components/library/dossierTypes";
import {
  modelSummary,
  previewInstruction,
} from "@/components/library/LibraryBriefControls";
import styles from "./LibraryBrief.module.css";

type DisplayEnvironment = ReturnType<typeof useRenderEnvironment>;

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function coverageLabel(
  sourceCount: number,
  coveredSourceCount: number,
  omittedSourceCount: number,
): string | null {
  if (sourceCount === 0) return null;
  const covered = coveredSourceCount;
  const omitted = omittedSourceCount;
  if (omitted > 0) {
    return `${covered} of ${sourceCount} sources covered (${omitted} omitted)`;
  }
  return `${countLabel(covered, "source")} covered`;
}

/**
 * The "Dossier history" disclosure: on-demand revision list with restore and
 * open-revision deep links (`?tab=intelligence&revision=…`).
 */
export default function LibraryBriefRevisions({
  libraryId,
  selectedRevisionId,
  onRestored,
  onError,
}: {
  libraryId: string;
  selectedRevisionId: string | null;
  onRestored: () => void;
  onError: (feedback: FeedbackContent) => void;
}) {
  const display = useRenderEnvironment();
  const router = usePaneRouter();
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
        await loadRevisions();
        onRestored();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        onError(toFeedback(err, { fallback: "Failed to restore revision" }));
      } finally {
        setRestoringId(null);
      }
    },
    [libraryId, loadRevisions, onError, onRestored],
  );

  const openRevision = useCallback(
    (revisionId: string) => {
      router.push(`/libraries/${libraryId}?tab=intelligence&revision=${revisionId}`);
    },
    [libraryId, router],
  );

  return (
    <div className={styles.history}>
      <button
        type="button"
        className={styles.historyToggle}
        aria-expanded={open}
        onClick={toggle}
      >
        Dossier history
      </button>
      {open ? (
        loading ? (
          <PaneLoadingState label="Loading history…" />
        ) : revisions && revisions.length > 0 ? (
          <ul className={styles.historyList}>
            {revisions.map((revision) => (
              <RevisionHistoryItem
                key={revision.revision_id}
                revision={revision}
                display={display}
                selectedRevisionId={selectedRevisionId}
                restoringId={restoringId}
                onOpen={openRevision}
                onRestore={restore}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.historyEmpty}>No revisions yet.</p>
        )
      ) : null}
    </div>
  );
}

function RevisionHistoryItem({
  revision,
  display,
  selectedRevisionId,
  restoringId,
  onOpen,
  onRestore,
}: {
  revision: RevisionSummary;
  display: DisplayEnvironment;
  selectedRevisionId: string | null;
  restoringId: string | null;
  onOpen: (revisionId: string) => void;
  onRestore: (revisionId: string) => Promise<void>;
}) {
  const coverage = coverageLabel(
    revision.source_count,
    revision.covered_source_count,
    revision.omitted_source_count,
  );
  const model = modelSummary(
    revision.model_provider ?? null,
    revision.model_name ?? null,
  );
  const instruction = previewInstruction(revision.custom_instruction ?? null);
  return (
    <li className={styles.historyItem}>
      <span className={styles.historyMeta}>
        {formatDisplayDate(revision.created_at, display, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }) ?? revision.created_at}
        {" · "}
        {revision.status}
        {" · "}
        {countLabel(revision.citation_count, "citation")}
        {coverage ? (
          <>
            {" · "}
            {coverage}
          </>
        ) : null}
        {model ? (
          <>
            {" · "}
            {model}
          </>
        ) : null}
        {revision.total_tokens ? (
          <>
            {" · "}
            {countLabel(revision.total_tokens, "token")}
          </>
        ) : null}
        {instruction ? (
          <>
            {" · "}
            {`Instruction: ${instruction}`}
          </>
        ) : null}
        {revision.is_current ? (
          <span className={styles.historyMark}>Current</span>
        ) : null}
        {revision.revision_id === selectedRevisionId ? (
          <span className={styles.historyMark}>Viewing</span>
        ) : null}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onOpen(revision.revision_id)}
        disabled={revision.revision_id === selectedRevisionId}
      >
        Open
      </Button>
      {!revision.is_current && revision.status === "ready" ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onRestore(revision.revision_id)}
          disabled={restoringId !== null}
        >
          Restore
        </Button>
      ) : null}
    </li>
  );
}
