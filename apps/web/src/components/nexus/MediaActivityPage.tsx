"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  ExternalLink,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { formatDisplayDate } from "@/lib/display/format";
import type {
  MediaActivityMediaItem,
  MediaActivityStage,
  MediaActivityUploadSessionItem,
  MediaRepairScope,
} from "@/lib/media/activityClient";
import { useMediaActivity } from "@/lib/media/MediaActivityProvider";
import {
  getFileUploadKind,
  isMediaIngestionDefect,
} from "@/lib/media/ingestionClient";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  mediaActivityAttentionCopy,
  mediaActivityKindLabel,
  mediaActivityRepairErrorMessage,
  mediaActivityStatusCopy,
} from "@/lib/status/mediaActivity";
import styles from "./MediaActivityPage.module.css";

const PIPELINE_STEPS = ["Upload", "Validate", "Extract", "Index"] as const;
type PipelineStep = (typeof PIPELINE_STEPS)[number];
type PipelineStepState = "Complete" | "Current" | "Upcoming" | "Attention";

function activityStatusLabel(item: MediaActivityMediaItem): string {
  return item.state.kind === "NeedsAttention"
    ? "Needs attention"
    : item.state.status;
}

function activitySummary(
  needsAttentionCount: number,
  activeCount: number,
): string {
  if (needsAttentionCount === 0) {
    return activeCount === 0
      ? "No imports need attention."
      : `${activeCount} in progress`;
  }
  const attention = mediaActivityAttentionCopy(needsAttentionCount);
  return activeCount === 0
    ? attention
    : `${attention} · ${activeCount} in progress`;
}

function activePipelineStep(stage: MediaActivityStage): PipelineStep {
  switch (stage) {
    case "Validate":
      return "Validate";
    case "Extract":
    case "Finalize":
      return "Extract";
    case "Index":
      return "Index";
  }
}

function pipelineStepState(
  item: MediaActivityMediaItem,
  step: PipelineStep,
): PipelineStepState {
  if (step === "Upload") return "Complete";
  const active = activePipelineStep(item.state.stage);
  const stepIndex = PIPELINE_STEPS.indexOf(step);
  const activeIndex = PIPELINE_STEPS.indexOf(active);
  if (stepIndex < activeIndex) return "Complete";
  if (stepIndex > activeIndex) return "Upcoming";
  return item.state.kind === "NeedsAttention" ? "Attention" : "Current";
}

function Pipeline({ item }: { item: MediaActivityMediaItem }) {
  return (
    <ol className={styles.pipeline} aria-label="Upload, validate, extract, index">
      {PIPELINE_STEPS.map((step) => {
        const state = pipelineStepState(item, step);
        return (
          <li
            key={step}
            aria-label={`${step} step`}
            data-state={state}
            aria-current={state === "Current" || state === "Attention" ? "step" : undefined}
          >
            <span className={styles.stepMark} aria-hidden="true">
              {state === "Complete" ? <Check size={11} /> : <Circle size={8} />}
            </span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ActivityDetails({
  item,
  updatedAt,
}: {
  item: MediaActivityMediaItem;
  updatedAt: string;
}) {
  const code =
    item.state.kind === "NeedsAttention"
      ? item.state.failureCode
      : item.state.statusCode;
  return (
    <details className={styles.details}>
      <summary>Details</summary>
      <dl>
        <div>
          <dt>Stage</dt>
          <dd>{item.state.stage}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{item.runCount}</dd>
        </div>
        <div>
          <dt>Queue attempts</dt>
          <dd>
            {item.queueAttempts} of {item.queueMaxAttempts}
          </dd>
        </div>
        {code.kind === "Present" ? (
          <div>
            <dt>Code</dt>
            <dd>
              <code>{code.value}</code>
            </dd>
          </div>
        ) : null}
        {item.requestId.kind === "Present" ? (
          <div>
            <dt>Request ID</dt>
            <dd>
              <code>{item.requestId.value}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={item.updatedAt}>{updatedAt}</time>
          </dd>
        </div>
        <div>
          <dt>Source attempt</dt>
          <dd>
            <code>{item.sourceAttemptId}</code>
          </dd>
        </div>
      </dl>
    </details>
  );
}

function MediaActivityRow({
  item,
  repairing,
  onOpen,
  onRepair,
  updatedAt,
}: {
  item: MediaActivityMediaItem;
  repairing: MediaRepairScope | null;
  onOpen(): void;
  onRepair(scope: MediaRepairScope): void;
  updatedAt: string;
}) {
  const statusCopy = mediaActivityStatusCopy(item);
  const actionSubject = useMemo<ResourceActionSubject>(
    () => ({ ref: canonicalResourceRef({ scheme: "media", id: item.mediaId }) }),
    [item.mediaId],
  );
  return (
    <li>
      <article className={styles.card} data-kind={item.state.kind}>
        <header className={styles.cardHeader}>
          <div>
            <p className={styles.kind}>{mediaActivityKindLabel(item.mediaKind)}</p>
            <h3>{item.title}</h3>
          </div>
          <span className={styles.status}>{activityStatusLabel(item)}</span>
        </header>
        <Pipeline item={item} />
        <div className={styles.facts}>
          <strong>{statusCopy}</strong>
        </div>
        <div className={styles.actions}>
          {item.capabilities.canOpen ? (
            <button type="button" className={styles.actionButton} onClick={onOpen}>
              <ExternalLink size={15} aria-hidden="true" />
              Open
            </button>
          ) : null}
          {item.capabilities.canRepairSource ? (
            <button
              type="button"
              className={styles.actionButton}
              disabled={repairing !== null}
              onClick={() => onRepair("Source")}
            >
              <Wrench size={15} aria-hidden="true" />
              {repairing === "Source" ? "Starting source repair…" : "Repair source"}
            </button>
          ) : null}
          {item.capabilities.canRepairSearch ? (
            <button
              type="button"
              className={styles.actionButton}
              disabled={repairing !== null}
              onClick={() => onRepair("Search")}
            >
              <Wrench size={15} aria-hidden="true" />
              {repairing === "Search" ? "Starting search repair…" : "Repair search"}
            </button>
          ) : null}
          {/* Every non-repair verb -- above all Remove -- is offered through the
              one canonical resource dropdown, never a page-local delete button.
              `canRemove` is the same `can_delete` fact the action-snapshot
              planner reads, so an attempt that failed terminally (a source the
              bounded parser rejected) still has the removal escape hatch and is
              never a row with zero actions. */}
          {item.capabilities.canRemove ? (
            <ResourceActionMenu
              actionSubject={actionSubject}
              label={`More actions for ${item.title}`}
            />
          ) : null}
        </div>
        <ActivityDetails item={item} updatedAt={updatedAt} />
      </article>
    </li>
  );
}

function uploadAttentionCopy(item: MediaActivityUploadSessionItem): string {
  switch (item.attention.kind) {
    case "TransportFailed":
      return item.attention.failureKind === "HttpRejected"
        ? "The storage service rejected this upload. Choose the original file to retry."
        : "The upload did not finish. Choose the original file to retry.";
    case "CapabilityExpired":
      return "The upload link expired. Choose the original file to retry.";
    case "VerificationFailed":
      switch (item.attention.failureCode) {
        case "E_FILE_TOO_LARGE":
          return "This file exceeds the import limit. Remove it and start a new import with a smaller file.";
        case "E_INVALID_FILE_TYPE":
          return "This file is not a valid PDF or EPUB. Remove it and start a new import.";
        default:
          return "Nexus could not verify the uploaded bytes. Remove this import and start a new one.";
      }
  }
}

function UploadSessionRow({
  item,
  onRetry,
  onRemove,
  updatedAt,
}: {
  item: MediaActivityUploadSessionItem;
  onRetry(file: File): Promise<void>;
  onRemove(): Promise<void>;
  updatedAt: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState<"Retry" | "Remove" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [defect, setDefect] = useState<unknown | null>(null);
  const attentionStep =
    item.attention.kind === "VerificationFailed" ? "Validate" : "Upload";
  const selectFile = async (file: File) => {
    if (
      file.name !== item.filename ||
      file.size !== item.expectedSizeBytes ||
      getFileUploadKind(file) !== item.documentKind
    ) {
      setFailure(
        `Choose ${item.filename} (${item.expectedSizeBytes} bytes), or return to Add to start a new import.`,
      );
      return;
    }
    setWorking("Retry");
    setFailure(null);
    try {
      await onRetry(file);
    } catch (error) {
      if (isMediaIngestionDefect(error)) setDefect(error);
      else setFailure("The upload could not be retried. Check your connection and try again.");
    } finally {
      setWorking(null);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove the unfinished import “${item.filename}”?`)) return;
    setWorking("Remove");
    setFailure(null);
    try {
      await onRemove();
    } catch (error) {
      if (isMediaIngestionDefect(error)) setDefect(error);
      else setFailure("The unfinished import could not be removed. Refresh and try again.");
    } finally {
      setWorking(null);
    }
  };
  if (defect !== null) throw defect;
  return (
    <li>
      <article
        className={styles.card}
        data-kind="NeedsAttention"
        aria-label={`${item.filename} upload`}
      >
        <header className={styles.cardHeader}>
          <div>
            <p className={styles.kind}>{item.documentKind.toUpperCase()} upload</p>
            <h3>{item.filename}</h3>
          </div>
          <span className={styles.status}>Needs attention</span>
        </header>
        <ol className={styles.pipeline} aria-label="Upload, validate, extract, index">
          {PIPELINE_STEPS.map((step) => {
            const stepIndex = PIPELINE_STEPS.indexOf(step);
            const attentionIndex = PIPELINE_STEPS.indexOf(attentionStep);
            const state =
              stepIndex < attentionIndex
                ? "Complete"
                : stepIndex === attentionIndex
                  ? "Attention"
                  : "Upcoming";
            return (
              <li
                key={step}
                aria-label={`${step} step`}
                data-state={state}
                aria-current={state === "Attention" ? "step" : undefined}
              >
                <span className={styles.stepMark} aria-hidden="true">
                  {state === "Complete" ? <Check size={11} /> : <Circle size={8} />}
                </span>
                <span>{step}</span>
              </li>
            );
          })}
        </ol>
        <div className={styles.facts}>
          <strong>{uploadAttentionCopy(item)}</strong>
          {failure === null ? null : <span role="alert">{failure}</span>}
        </div>
        <div className={styles.actions}>
          {item.capabilities.canRetryUpload ? (
            <>
              <input
                ref={inputRef}
                className={styles.srOnly}
                type="file"
                aria-label={`Choose ${item.filename} to retry upload`}
                accept=".pdf,.epub,application/pdf,application/epub+zip"
                disabled={working !== null}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void selectFile(file);
                }}
              />
              <button
                type="button"
                className={styles.actionButton}
                disabled={working !== null}
                onClick={() => inputRef.current?.click()}
              >
                <Upload size={15} aria-hidden="true" />
                {working === "Retry" ? "Uploading…" : "Retry upload"}
              </button>
            </>
          ) : null}
          {item.capabilities.canRemove ? (
            <button
              type="button"
              className={styles.actionButton}
              disabled={working !== null}
              onClick={() => void remove()}
            >
              <Trash2 size={15} aria-hidden="true" />
              {working === "Remove" ? "Removing…" : "Remove"}
            </button>
          ) : null}
        </div>
        <details className={styles.details}>
          <summary>Details</summary>
          <dl>
            <div>
              <dt>Expected size</dt>
              <dd>{item.expectedSizeBytes} bytes</dd>
            </div>
            {item.attention.kind === "VerificationFailed" ? (
              <div>
                <dt>Code</dt>
                <dd><code>{item.attention.failureCode}</code></dd>
              </div>
            ) : null}
            <div>
              <dt>Updated</dt>
              <dd><time dateTime={item.updatedAt}>{updatedAt}</time></dd>
            </div>
          </dl>
        </details>
      </article>
    </li>
  );
}

export default function MediaActivityPage({
  onBack,
  onOpenMedia,
  visible = true,
}: {
  onBack(): void;
  onOpenMedia(mediaId: string): void;
  /**
   * Whether this workflow is actually on screen. The mobile switchboard keeps a
   * dismissed task mounted behind `hidden`/`inert`, so mount alone must not be
   * read as "Activity is open" -- that would poll forever and never restart the
   * per-opening window.
   */
  visible?: boolean;
}) {
  const {
    snapshot,
    loadState,
    automaticRefreshEnded,
    beginActivityOpening,
    endActivityOpening,
    refreshActivity,
    repairActivity,
    retryUploadSession,
    removeUploadSession,
  } = useMediaActivity();
  const display = useRenderEnvironment();
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const [repairing, setRepairing] = useState<{
    readonly mediaId: string;
    readonly scope: MediaRepairScope;
  } | null>(null);
  const [repairFailure, setRepairFailure] = useState<
    ReturnType<typeof mediaActivityRepairErrorMessage> | null
  >(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const announcedAttentionCountRef = useRef<number | null>(null);
  const [attentionAnnouncement, setAttentionAnnouncement] = useState("");
  // Tracks only the user's own Refresh press. The provider's `refreshing` flag
  // also flips on every background poll, which would disable and relabel a
  // focused button every five seconds and blur it out from under a keyboard user.
  const [userRefreshing, setUserRefreshing] = useState(false);

  useEffect(() => {
    if (!visible) return;
    beginActivityOpening();
    return endActivityOpening;
  }, [visible, beginActivityOpening, endActivityOpening]);

  useEffect(() => {
    if (snapshot === null) return;
    const previousCount = announcedAttentionCountRef.current;
    announcedAttentionCountRef.current = snapshot.needsAttentionCount;
    // A live region is for new information, not a summary of work that was
    // already present when Activity opened. While hidden, retain the latest
    // known count so reopening is quiet for the same reason.
    if (
      previousCount === null ||
      previousCount === snapshot.needsAttentionCount ||
      !visible
    ) {
      return;
    }
    setAttentionAnnouncement(
      `${mediaActivityAttentionCopy(snapshot.needsAttentionCount)}.`,
    );
  }, [snapshot, visible]);

  const repair = async (mediaId: string, scope: MediaRepairScope) => {
    setRepairing({ mediaId, scope });
    setRepairFailure(null);
    try {
      await repairActivity(mediaId, scope);
    } catch (error) {
      if (handleUnauthenticated(error)) return;
      try {
        setRepairFailure(mediaActivityRepairErrorMessage(error));
      } catch (caughtDefect: unknown) {
        setDefect({ error: caughtDefect });
      }
    } finally {
      setRepairing(null);
    }
  };

  if (defect !== null) throw defect.error;

  const summary =
    snapshot === null
      ? "Loading Activity…"
      : activitySummary(snapshot.needsAttentionCount, snapshot.activeCount);
  const totalCount =
    snapshot === null
      ? 0
      : snapshot.needsAttentionCount + snapshot.activeCount;

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label="Back to Nexus">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <h2 tabIndex={-1} data-switchboard-heading>
            Activity
          </h2>
          <p>{summary}</p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => {
            setUserRefreshing(true);
            void refreshActivity().finally(() => setUserRefreshing(false));
          }}
          disabled={userRefreshing}
          aria-label="Refresh activity"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {userRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {automaticRefreshEnded ? (
        <p className={styles.pollingEnded}>
          <strong>Automatic updates ended.</strong> Refresh to check again.
        </p>
      ) : null}

      {repairFailure === null ? null : (
        <FeedbackNotice content={repairFailure} announcement="Assertive" />
      )}
      {loadState.kind === "Failed" ? (
        <FeedbackNotice
          content={loadState.content}
          announcement="Assertive"
          actions={[{ label: "Refresh", onClick: () => void refreshActivity() }]}
        />
      ) : null}
      <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {attentionAnnouncement}
      </p>

      {snapshot === null && loadState.kind === "Loading" ? (
        <p className={styles.empty}>
          Loading Activity…
        </p>
      ) : snapshot === null ? null : snapshot.items.length === 0 ? (
        <div className={styles.empty}>
          <strong>No imports need attention.</strong>
          <p>New import failures will appear here.</p>
        </div>
      ) : (
        <>
          {snapshot.hasMore ? (
            <p className={styles.truncation}>
              Showing {snapshot.items.length} of {totalCount} imports.
            </p>
          ) : null}
          <ul className={styles.list}>
            {snapshot.items.map((item) => {
              const updatedAt =
                formatDisplayDate(item.updatedAt, display, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }) ?? item.updatedAt;
              return item.kind === "UploadSession" ? (
                <UploadSessionRow
                  key={`UploadSession:${item.sessionHandle}`}
                  item={item}
                  onRetry={(file) => retryUploadSession(item.sessionHandle, file)}
                  onRemove={() => removeUploadSession(item.sessionHandle)}
                  updatedAt={updatedAt}
                />
              ) : (
                <MediaActivityRow
                  key={`Media:${item.mediaId}`}
                  item={item}
                  repairing={
                    repairing?.mediaId === item.mediaId ? repairing.scope : null
                  }
                  onOpen={() => onOpenMedia(item.mediaId)}
                  onRepair={(scope) => void repair(item.mediaId, scope)}
                  updatedAt={updatedAt}
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
