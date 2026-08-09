"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  ExternalLink,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { formatDisplayDate } from "@/lib/display/format";
import {
  libraryPlacementUnknownSince,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import type {
  MediaActivityItem,
  MediaActivityStage,
  MediaRepairScope,
} from "@/lib/media/activityClient";
import { useMediaActivity } from "@/lib/media/MediaActivityProvider";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  mediaActivityKindLabel,
  mediaActivityProgressCopy,
  mediaActivityRepairErrorMessage,
  mediaActivityStatusCopy,
} from "@/lib/status/mediaActivity";
import styles from "./MediaActivityPage.module.css";

const PIPELINE_STEPS = ["Upload", "Validate", "Extract", "Index"] as const;
type PipelineStep = (typeof PIPELINE_STEPS)[number];
type PipelineStepState = "Complete" | "Current" | "Upcoming" | "Attention";

function activityStatusLabel(item: MediaActivityItem): string {
  return item.status === "NeedsAttention" ? "Needs attention" : item.status;
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
  item: MediaActivityItem,
  step: PipelineStep,
): PipelineStepState {
  if (step === "Upload") return "Complete";
  if (item.status === "Ready" && item.stage.kind === "Absent") {
    return "Complete";
  }
  const active =
    item.stage.kind === "Present"
      ? activePipelineStep(item.stage.value)
      : "Validate";
  const stepIndex = PIPELINE_STEPS.indexOf(step);
  const activeIndex = PIPELINE_STEPS.indexOf(active);
  if (stepIndex < activeIndex) return "Complete";
  if (stepIndex > activeIndex) return "Upcoming";
  return item.status === "NeedsAttention" ? "Attention" : "Current";
}

function Pipeline({ item }: { item: MediaActivityItem }) {
  return (
    <ol className={styles.pipeline} aria-label="Upload, validate, extract, index">
      {PIPELINE_STEPS.map((step) => {
        const state = pipelineStepState(item, step);
        return (
          <li
            key={step}
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
  item: MediaActivityItem;
  updatedAt: string;
}) {
  return (
    <details className={styles.details}>
      <summary>Details</summary>
      <dl>
        <div>
          <dt>Stage</dt>
          <dd>{item.stage.kind === "Present" ? item.stage.value : "Complete"}</dd>
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
        {item.failureCode.kind === "Present" ? (
          <div>
            <dt>Code</dt>
            <dd>
              <code>{item.failureCode.value}</code>
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

function ActivityRow({
  item,
  repairing,
  onOpen,
  onRepair,
  updatedAt,
}: {
  item: MediaActivityItem;
  repairing: MediaRepairScope | null;
  onOpen(): void;
  onRepair(scope: MediaRepairScope): void;
  updatedAt: string;
}) {
  const statusCopy = mediaActivityStatusCopy(item);
  const countedDetail =
    item.status === "NeedsAttention" && item.progress.kind === "Present"
      ? mediaActivityProgressCopy(item.progress.value)
      : null;
  const actionSubject = useMemo<ResourceActionSubject>(
    () => ({ ref: canonicalResourceRef({ scheme: "media", id: item.mediaId }) }),
    [item.mediaId],
  );
  return (
    <li>
      <article className={styles.card} data-status={item.status}>
        <header className={styles.cardHeader}>
          <div>
            <p className={styles.kind}>{mediaActivityKindLabel(item.mediaKind)}</p>
            <h3>{item.title}</h3>
          </div>
          <span className={styles.status}>{activityStatusLabel(item)}</span>
        </header>
        <Pipeline item={item} />
        <div className={styles.facts} aria-live="polite">
          <strong>{statusCopy}</strong>
          {countedDetail === null ? null : <span>{countedDetail}</span>}
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
  // Tracks only the user's own Refresh press. The provider's `refreshing` flag
  // also flips on every background poll, which would disable and relabel a
  // focused button every five seconds and blur it out from under a keyboard user.
  const [userRefreshing, setUserRefreshing] = useState(false);

  useEffect(() => {
    if (!visible) return;
    beginActivityOpening();
    return endActivityOpening;
  }, [visible, beginActivityOpening, endActivityOpening]);

  // Removing a row's media through the canonical dropdown publishes an
  // Unknown-scoped placement change; that is the only completion signal the
  // resource-action runtime gives a surface it does not own. Re-read the
  // composed snapshot on it so the removed row and the open-items badge drop
  // immediately instead of waiting for the next poll -- or forever, once the
  // per-opening polling window has expired.
  const placementChange = useLibraryPlacementRevision();
  const observedPlacementRevisionRef = useRef(placementChange.revision);
  useEffect(() => {
    const observed = observedPlacementRevisionRef.current;
    if (placementChange.revision === observed) return;
    observedPlacementRevisionRef.current = placementChange.revision;
    if (!libraryPlacementUnknownSince(observed)) return;
    void refreshActivity();
  }, [placementChange.revision, refreshActivity]);

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
          <p>
            {snapshot === null
              ? "Recent media work"
              : `${snapshot.nonterminalCount} open ${snapshot.nonterminalCount === 1 ? "item" : "items"}`}
          </p>
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
        <p className={styles.pollingEnded} role="status">
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

      {snapshot === null && loadState.kind === "Loading" ? (
        <p className={styles.empty} role="status">
          Loading Activity…
        </p>
      ) : snapshot === null ? null : snapshot.items.length === 0 ? (
        <div className={styles.empty}>
          <strong>No recent media work</strong>
          <p>New imports and indexing work will appear here.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {snapshot.items.map((item) => (
            <ActivityRow
              key={item.mediaId}
              item={item}
              repairing={
                repairing?.mediaId === item.mediaId ? repairing.scope : null
              }
              onOpen={() => onOpenMedia(item.mediaId)}
              onRepair={(scope) => void repair(item.mediaId, scope)}
              updatedAt={
                formatDisplayDate(item.updatedAt, display, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }) ?? item.updatedAt
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
