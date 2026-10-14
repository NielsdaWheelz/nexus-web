"use client";

import { useMemo, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import MetadataResearchActions, {
  MetadataReviewButton,
} from "@/components/media/MetadataResearchActions";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import { usePagePrefix } from "@/lib/api/pagePrefix";
import {
  fetchImportDetail,
  fetchImportHistory,
  type HistoryEntry,
  type ImportItem,
} from "@/lib/imports/api";
import {
  KIND_LABEL,
  MATCHED_ANNOUNCEMENT,
  MATCHED_LABEL,
  UNAVAILABLE_LINE,
  consequenceLine,
  coverageLine,
  eventLine,
  loadFailure,
  matchLine,
  momentText,
  obligationStatusLine,
  importFailureCopy,
  recoveryLine,
  stageLabel,
  sourceFailureLine,
  stateBadge,
} from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  earlierMetadataRuns,
  METADATA_FAILURE_COPY,
  METADATA_FIELD_LABELS,
  METADATA_REVIEW_HELP,
  metadataOperationName,
  metadataOperationSummary,
  metadataRetryBlockedCopy,
} from "@/lib/media/mediaMetadataCopy";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { ImportObligationActions } from "./ImportRow";
import styles from "./Imports.module.css";

/** The server no longer has this import, or never had one by that ref. */
const gone = (error: ApiError | null) =>
  error?.code === "E_IMPORT_NOT_FOUND" || error?.code === "E_INVALID_REQUEST";

function OpenSavedCopy({ mediaId }: { readonly mediaId: string }) {
  const subject = useMemo(
    () => ({ ref: canonicalResourceRef({ scheme: "media", id: mediaId }) }),
    [mediaId],
  );
  const model = useResourceActionMenuModel(subject);
  const open = model.descriptors.find(
    (action) => action.id === "ResourceAction.Open",
  );
  return open?.kind === "command" ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={open.disabled}
      onClick={() => open.onSelect({ triggerEl: null })}
    >
      open saved copy
    </Button>
  ) : null;
}

/**
 * The inspected import in the order a reader needs it: what it means for them,
 * what a recovery reuses and repeats, the attempts actually recorded, and the
 * identifiers underneath. It rereads on every observation.
 */
export default function ImportInspector({
  importRef,
  matched,
}: {
  readonly importRef: string;
  /** The event the open view matched it on; only the listed row knows. */
  readonly matched: ImportItem["matched_event"];
}) {
  const display = useRenderEnvironment();
  const { observation } = useImports();
  const detail = usePaneFreeServerValue({
    key: importRef,
    stale: observation,
    load: (signal) => fetchImportDetail(importRef, signal),
  });
  if (detail.status === "loading") {
    return (
      <PaneLoadingState label="Loading this import" announcement="Polite" />
    );
  }
  if (gone(detail.error)) {
    return <p className={styles.inspectorEmpty}>{UNAVAILABLE_LINE}</p>;
  }
  if (detail.status === "failed") {
    return (
      <FeedbackNotice
        content={loadFailure(detail.error)}
        announcement="Assertive"
        actions={[{ label: "Try again", onClick: detail.refetch }]}
      />
    );
  }
  const { item, readiness, history_coverage: coverage } = detail.data;
  const issues = detail.data.source_issues;
  const badge = stateBadge(item);
  const metadata =
    item.obligations.metadata.kind === "Present"
      ? item.obligations.metadata.value
      : null;
  const operation =
    metadata?.operation.kind === "Present" ? metadata.operation.value : null;
  const earlierRuns = metadata === null ? 0 : earlierMetadataRuns(metadata);
  const mediaId =
    item.media_ref.kind === "Present"
      ? item.media_ref.value.slice("media:".length)
      : null;
  const state = item.state;
  const field = (label: string, value: ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const moment = (value: string) => (
    <time dateTime={value}>{momentText(value, display)}</time>
  );
  return (
    <div className={styles.inspector}>
      <PaneSection title={item.title}>
        <p className={styles.inspectorState}>
          <Pill tone={badge.tone} size="sm">
            {badge.label}
          </Pill>
          <span>
            {consequenceLine(item, readiness.can_read, readiness.can_play)}
          </span>
        </p>
        {matched.kind === "Present" ? (
          <p className={styles.rowMatched}>
            {matchLine(matched.value, display, new Date())}
          </p>
        ) : null}
      </PaneSection>
      {issues.kind === "Present" && issues.value.issues.length > 0 ? (
        <PaneSection title="Source quality">
          <SourceIssuesNotice
            issues={issues.value.issues}
            readable={readiness.can_read}
          />
        </PaneSection>
      ) : null}
      {(["source", "search"] as const).map((key) => {
        const slot = item.obligations[key];
        if (slot.kind === "Absent") return null;
        const recovery = recoveryLine(slot.value);
        const state = slot.value.state;
        const retained = key === "source" ? sourceFailureLine(item) : null;
        return (
          <PaneSection key={key} title={key === "source" ? "Source" : "Search"}>
            <p>{retained ?? obligationStatusLine(state)}</p>
            {state.kind === "NeedsAttention" &&
            state.failure_code.kind === "Present" ? (
              <p>{importFailureCopy(state.failure_code.value).reason}</p>
            ) : null}
            {recovery === null ? null : <p>{recovery}</p>}
            <div className={styles.inspectorActions}>
              {retained !== null && mediaId !== null ? (
                <OpenSavedCopy mediaId={mediaId} />
              ) : null}
              <ImportObligationActions item={item} obligation={key} />
            </div>
          </PaneSection>
        );
      })}
      {metadata === null || mediaId === null ? null : (
        <PaneSection
          title={metadataOperationName(operation?.purpose ?? metadata.retry.purpose)}
        >
          <p>
            {operation === null
              ? `no recorded ${metadataOperationName(metadata.retry.purpose)}`
              : metadataOperationSummary(operation, (at) =>
                  momentText(at, display),
                )}
          </p>
          {operation?.status === "failed" ? (
            <p>{METADATA_FAILURE_COPY[operation.code]}</p>
          ) : null}
          {operation?.status === "no_findings" &&
          operation.reviewed_at.kind === "Absent" ? (
            <p>{METADATA_REVIEW_HELP}</p>
          ) : null}
          {operation?.status === "completed" &&
          operation.outcome.purpose === "bibliography" &&
          operation.outcome.unresolved_fields.length > 0 ? (
            <p>
              not established by this run:{" "}
              {operation.outcome.unresolved_fields
                .map((name) => METADATA_FIELD_LABELS[name])
                .join(", ")}
            </p>
          ) : null}
          {earlierRuns > 0 ? (
            <p>
              {earlierRuns} earlier metadata{" "}
              {earlierRuns === 1 ? "run remains" : "runs remain"} unfinished
            </p>
          ) : null}
          {metadata.unfinished_operation.kind === "Present" &&
          metadata.unfinished_operation.value.job_id !== operation?.job_id ? (
            <p>
              {metadataOperationSummary(
                metadata.unfinished_operation.value,
                (at) => momentText(at, display),
              )}{" "}
              · {moment(metadata.unfinished_operation.value.created_at)} ·{" "}
              <code>{metadata.unfinished_operation.value.job_id}</code>
            </p>
          ) : null}
          {metadata.retry.status === "blocked" ? (
            <p>{metadataRetryBlockedCopy(metadata.retry)}</p>
          ) : null}
          <div className={styles.inspectorActions}>
            <MetadataResearchActions mediaId={mediaId} view={metadata} />
          </div>
          {operation === null ? null : (
            <details className={styles.diagnostics}>
              <summary>operation details</summary>
              <dl>
                {field("Job", <code>{operation.job_id}</code>)}
                {operation.generation_id.kind === "Present"
                  ? field(
                      "Generation",
                      <code>{operation.generation_id.value}</code>,
                    )
                  : null}
                {field("Requested", moment(operation.created_at))}
                {operation.started_at.kind === "Present"
                  ? field("Started", moment(operation.started_at.value))
                  : null}
                {operation.status === "completed"
                  ? field("Finished", moment(operation.outcome.completed_at))
                  : operation.status === "failed" ||
                      operation.status === "no_findings"
                    ? field("Finished", moment(operation.completed_at))
                    : null}
                {operation.status === "waiting" &&
                operation.until.kind === "Present"
                  ? field("Next retry", moment(operation.until.value))
                  : null}
                {operation.status === "no_findings" &&
                operation.reviewed_at.kind === "Present"
                  ? field("Reviewed", moment(operation.reviewed_at.value))
                  : null}
              </dl>
            </details>
          )}
        </PaneSection>
      )}
      <PaneSection
        title="Attempts"
        description={
          coverage.kind === "Partial"
            ? coverageLine(coverage.recorded_since, display)
            : undefined
        }
      >
        <Attempts
          importRef={importRef}
          mediaId={mediaId}
          updatedAt={item.updated_at}
          matchedId={matched.kind === "Present" ? matched.value.id : null}
        />
      </PaneSection>
      <details className={styles.diagnostics}>
        <summary>Details</summary>
        <dl>
          {field("Import", <code>{item.ref}</code>)}
          {field("Kind", KIND_LABEL[item.media_kind])}
          {state.kind === "Complete"
            ? null
            : field("Stage", stageLabel(state.stage))}
          {state.kind === "NeedsAttention" &&
          state.failure_code.kind === "Present"
            ? field("Code", <code>{state.failure_code.value}</code>)
            : null}
          {field("Accepted", moment(item.accepted_at))}
          {field("Updated", moment(item.updated_at))}
        </dl>
      </details>
    </div>
  );
}

/**
 * Recorded events as the attempts they belong to (upload generation, source
 * attempt, index revision), newest attempt first, each newest event first.
 */
function attempts(entries: readonly HistoryEntry[]) {
  const groups = new Map<string, { label: string; entries: HistoryEntry[] }>();
  for (const entry of entries) {
    const facts = entry.facts;
    const [id, label] =
      facts.kind === "MetadataOperation"
        ? [
            `Metadata:${facts.operation.job_id}`,
            metadataOperationName(facts.operation.purpose),
          ]
        : "generation" in facts
          ? [`Upload:${facts.generation}`, `Upload attempt ${facts.generation}`]
          : "source_attempt_id" in facts
            ? [`Source:${facts.source_attempt_id}`, "Source attempt"]
            : [
                `Index:${facts.revision}`,
                `Search index revision ${facts.revision}`,
              ];
    let group = groups.get(id);
    if (group === undefined) {
      group = { label, entries: [] };
      groups.set(id, group);
    }
    group.entries.push(entry);
    if ("attempt_no" in facts)
      group.label = `Source attempt ${facts.attempt_no}`;
  }
  return [...groups];
}

/**
 * The attempt timeline: a second read that follows the import's `updated_at`,
 * so running work narrates itself. An import gone since its detail shows none.
 */
function Attempts({
  importRef,
  mediaId,
  updatedAt,
  matchedId,
}: {
  readonly importRef: string;
  readonly mediaId: string | null;
  readonly updatedAt: string;
  readonly matchedId: string | null;
}) {
  const display = useRenderEnvironment();
  const {
    prefix: history,
    short,
    loadMore,
  } = usePagePrefix(importRef, updatedAt, (cursor, signal) =>
    fetchImportHistory(importRef, cursor, signal),
  );
  if (history.status === "loading") {
    return (
      <PaneLoadingState label="Loading recorded attempts" announcement="None" />
    );
  }
  if (history.status === "failed") {
    return gone(history.error) ? null : (
      <FeedbackNotice
        content={loadFailure(history.error)}
        announcement="Polite"
        actions={[{ label: "Try again", onClick: history.refetch }]}
      />
    );
  }
  const entries = history.data.pages.flatMap((page) => page.entries);
  return (
    <>
      {attempts(entries).map(([id, group]) => (
        <section key={id} className={styles.attempt}>
          <h3 className={styles.attemptTitle}>{group.label}</h3>
          <ol className={styles.attemptEvents}>
            {group.entries.map((entry) => (
              <li
                key={entry.id}
                aria-current={entry.id === matchedId ? "true" : undefined}
              >
                <span>{eventLine(entry)}</span>
                {mediaId !== null &&
                entry.facts.kind === "MetadataOperation" &&
                entry.facts.operation.status === "no_findings" &&
                entry.facts.operation.reviewed_at.kind === "Absent" ? (
                  <MetadataReviewButton
                    mediaId={mediaId}
                    jobId={entry.facts.operation.job_id}
                  />
                ) : null}
                {entry.id === matchedId ? (
                  <Pill tone="info" size="sm">
                    <span aria-hidden="true">{MATCHED_LABEL}</span>
                    <span className="sr-only">{MATCHED_ANNOUNCEMENT}</span>
                  </Pill>
                ) : null}
                <time dateTime={entry.occurred_at}>
                  {momentText(entry.occurred_at, display)}
                </time>
                {entry.facts.kind === "MetadataOperation" ? (
                  <details className={styles.diagnostics}>
                    <summary>operation details</summary>
                    <dl>
                      <div>
                        <dt>Job</dt>
                        <dd>
                          <code>{entry.facts.operation.job_id}</code>
                        </dd>
                      </div>
                      {entry.facts.operation.generation_id.kind ===
                      "Present" ? (
                        <div>
                          <dt>Generation</dt>
                          <dd>
                            <code>
                              {entry.facts.operation.generation_id.value}
                            </code>
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Requested</dt>
                        <dd>
                          {momentText(
                            entry.facts.operation.created_at,
                            display,
                          )}
                        </dd>
                      </div>
                      {entry.facts.operation.status === "no_findings" &&
                      entry.facts.operation.reviewed_at.kind === "Present" ? (
                        <div>
                          <dt>Reviewed</dt>
                          <dd>
                            {momentText(
                              entry.facts.operation.reviewed_at.value,
                              display,
                            )}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
      <LoadMoreFooter
        hasMore={history.data.more && !(short && history.error !== null)}
        loading={short && history.error === null}
        onLoadMore={loadMore}
        label="Load earlier events"
      />
    </>
  );
}
