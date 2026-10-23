"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus } from "@/components/feedback/Feedback";
import MetadataResearchActions, {
  MetadataReviewButton,
} from "@/components/media/MetadataResearchActions";
import ButtonLink from "@/components/ui/ButtonLink";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
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
  eventLine,
  importFailureCopy,
  loadFailure,
  matchLine,
  momentText,
  obligationStatusLine,
  recoveryLine,
  relatedSourceOutcomeLine,
  sourceFailureLine,
  speaking,
  stageLabel,
} from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { encodeImportsUrl } from "@/lib/imports/query";
import {
  METADATA_FAILURE_COPY,
  METADATA_FIELD_LABELS,
  METADATA_REVIEW_HELP,
  earlierMetadataRuns,
  metadataOperationName,
  metadataOperationSummary,
  metadataRetryBlockedCopy,
} from "@/lib/media/mediaMetadataCopy";
import type { MetadataOperation } from "@/lib/media/mediaMetadataOperations";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import { ImportObligationActions, ImportOpenAction } from "./ImportActions";
import styles from "./Imports.module.css";

const HISTORY = definePaneVisitDataKey<ListSnapshot<HistoryEntry>>("Imports.History");
const HISTORY_UNIT = { singular: "event", plural: "events" };

/** The server no longer has this import, or never had one by that ref. */
const gone = (error: ApiError | null) =>
  error?.code === "E_IMPORT_NOT_FOUND" || error?.code === "E_INVALID_REQUEST";

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Moment({ value }: { readonly value: string }) {
  const display = useRenderEnvironment();
  return <time dateTime={value}>{momentText(value, display)}</time>;
}

/** One metadata operation's identifiers and times, in its section and in History. */
function OperationDetails({
  operation,
}: {
  readonly operation: MetadataOperation;
}) {
  const finished =
    operation.status === "completed"
      ? operation.outcome.completed_at
      : operation.status === "failed" || operation.status === "no_findings"
        ? operation.completed_at
        : null;
  return (
    <details className={styles.diagnostics}>
      <summary>operation details</summary>
      <dl>
        <Field label="Job">
          <code>{operation.job_id}</code>
        </Field>
        {operation.generation_id !== null ? (
          <Field label="Generation">
            <code>{operation.generation_id}</code>
          </Field>
        ) : null}
        <Field label="Requested">
          <Moment value={operation.created_at} />
        </Field>
        {operation.started_at !== null ? (
          <Field label="Started">
            <Moment value={operation.started_at} />
          </Field>
        ) : null}
        {finished !== null ? (
          <Field label="Finished">
            <Moment value={finished} />
          </Field>
        ) : null}
        {operation.status === "waiting" && operation.until !== null ? (
          <Field label="Next retry">
            <Moment value={operation.until} />
          </Field>
        ) : null}
        {operation.status === "no_findings" &&
        operation.reviewed_at !== null ? (
          <Field label="Reviewed">
            <Moment value={operation.reviewed_at} />
          </Field>
        ) : null}
      </dl>
    </details>
  );
}

/**
 * The inspected import in the order a reader needs it: what it means for them,
 * what a recovery reuses and repeats, the attempts actually recorded, and the
 * identifiers underneath. It rereads on every observation; its History reads
 * only while open.
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
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportInspector");
  const { observation } = useImports();
  const detail = usePaneFreeServerValue({
    key: `/imports/${encodeURIComponent(importRef)}`,
    stale: observation,
    load: (signal) => fetchImportDetail(importRef, signal),
  });
  // A direct match admits the initial history; later observations never reopen it.
  const [historyOpen, setHistoryOpen] = useState(matched !== null);
  const historySummary = useRef<HTMLElement>(null);
  if (detail.status === "loading") {
    return (
      <PaneLoadingState label="Loading this import" announcement="Polite" />
    );
  }
  if (gone(detail.error)) {
    return <FeedbackState content={{ tone: "Neutral", title: UNAVAILABLE_LINE }} announcement="Polite" />;
  }
  if (detail.status === "failed") {
    return (
      <FeedbackState
        content={loadFailure(detail.error)}
        announcement="Assertive"
        actions={[{ label: "try again", onClick: detail.refetch, busy: detail.retrying }]}
      />
    );
  }
  const { item, source_issues: issues, related_imports: related } = detail.data;
  const mediaId = item.media_id;
  const metadata = item.obligations.metadata;
  const operation = metadata?.operation ?? null;
  const earlierRuns = metadata === null ? 0 : earlierMetadataRuns(metadata);
  const at = (value: string) => momentText(value, display);
  const primary = speaking(item);
  return (
    <div className={styles.inspector}>
      {detail.error === null ? null : (
        <FeedbackNotice
          content={{
            ...loadFailure(detail.error),
            tone: "Warning",
            title: "couldn’t refresh this import",
            message: "showing the last update",
          }}
          announcement="Polite"
          actions={[{ label: "try again", onClick: detail.refetch, busy: detail.refreshing }]}
        />
      )}
      <header className={styles.inspectorHeading}>
        <h2>{item.title}</h2>
        <FeedbackStatus content={{
          tone: item.classification === "NeedsAttention" ? "Warning" : "Neutral",
          title: consequenceLine(item, at),
        }} announcement="None" />
        <p className={styles.provenance}>
          <span>{KIND_LABEL[item.media_kind]}</span>
          {item.source_label !== null ? <span>{item.source_label}</span> : null}
          {item.original_filename !== null ? (
            <span>original file: {item.original_filename}</span>
          ) : null}
        </p>
        {mediaId !== null && (item.can_read || item.can_play) ? (
          <div className={styles.inspectorActions}>
            <ImportOpenAction item={item} />
          </div>
        ) : null}
        {matched !== null ? (
          <p className={styles.rowMatched}>
            {matchLine(matched, display, new Date())}
          </p>
        ) : null}
      </header>
      {related.map((relatedImport) => {
        const { relation, item: sibling } = relatedImport;
        const sourceOutcome = relatedSourceOutcomeLine(item, relatedImport);
        const target: WorkspaceTarget = {
          href: `/imports?${encodeImportsUrl({ selected: sibling.ref })}`,
          secondaryActivation: { surfaceId: "import-detail" },
        };
        return (
          <section key={sibling.ref} className={styles.inspectorSection}>
            <h3>related {relation}</h3>
            <p>{sibling.title}</p>
            {sourceOutcome !== null ? <p>{sourceOutcome}</p> : null}
            <FeedbackStatus content={{
              tone: sibling.classification === "NeedsAttention" ? "Warning" : "Neutral",
              title: consequenceLine(sibling, at),
            }} announcement="None" />
            <div className={styles.inspectorActions}>
              <ImportOpenAction item={sibling} />
              <ButtonLink href={target.href} data-workspace-rich-target="true"
                onClick={event => activateTargetLink({ event, runtime, target })}
                onKeyDown={event => activateTargetLink({ event, runtime, target })}>
                view {relation} import
              </ButtonLink>
            </div>
          </section>
        );
      })}
      {issues.length > 0 ? (
        <section className={styles.inspectorSection}>
          <h3>Source quality</h3>
          <SourceIssuesNotice issues={issues} readable={item.can_read} />
        </section>
      ) : null}
      {(["source", "search"] as const).map((key) => {
        const slot = item.obligations[key];
        if (slot === null) return null;
        const recovery = recoveryLine(slot);
        return (
          <section key={key} className={styles.inspectorSection}>
            <h3>{key === "source" ? "Source" : "Search"}</h3>
            <FeedbackStatus content={{
              tone: slot.classification === "NeedsAttention" ? "Warning" : "Neutral",
              title: (key === "source" ? sourceFailureLine(item) : null) ?? obligationStatusLine(slot, mediaId === null && key === "source", at),
              message: [
                slot.classification === "NeedsAttention" && slot.failure_code !== null
                  ? `${importFailureCopy(slot.failure_code).reason}. ${importFailureCopy(slot.failure_code).explanation}` : null,
                recovery,
                slot.recovery?.kind === "RetryUpload" && item.original_filename !== null
                  ? `choose the original file: ${item.original_filename}` : null,
              ].filter(Boolean).join(" ") || undefined,
            }} announcement="None" />
            <div className={styles.inspectorActions}>
              <ImportObligationActions item={item} obligation={key} />
            </div>
          </section>
        );
      })}
      {metadata === null || mediaId === null ? null : (
        <section className={styles.inspectorSection}>
          <h3>
            {metadataOperationName(
              operation?.purpose ?? metadata.retry.purpose,
            )}
          </h3>
          <FeedbackStatus content={{
            tone: operation?.status === "failed" ? "Warning" : "Neutral",
            title: operation === null
              ? `no recorded ${metadataOperationName(metadata.retry.purpose)}`
              : metadataOperationSummary(operation, at),
            message: operation?.status === "failed" ? METADATA_FAILURE_COPY[operation.code]
              : operation?.status === "no_findings" && operation.reviewed_at === null ? METADATA_REVIEW_HELP
                : undefined,
          }} announcement="None" />
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
          {metadata.unfinished_operation !== null &&
          metadata.unfinished_operation.job_id !== operation?.job_id ? (
            <p>
              {metadataOperationSummary(metadata.unfinished_operation, at)} ·{" "}
              <Moment value={metadata.unfinished_operation.created_at} />
            </p>
          ) : null}
          {metadata.retry.status === "blocked" &&
          !(metadata.retry.reason === "active" &&
            metadata.unfinished_operation !== null) ? (
            <FeedbackStatus content={{ tone: "Neutral", title: metadataRetryBlockedCopy(metadata.retry) }} announcement="None" />
          ) : null}
          <div className={styles.inspectorActions}>
            <MetadataResearchActions mediaId={mediaId} view={metadata} />
          </div>
          {operation === null ? null : (
            <OperationDetails operation={operation} />
          )}
        </section>
      )}
      <details
        className={styles.history}
        open={historyOpen}
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary ref={historySummary}>History</summary>
        {historyOpen ? (
          <Attempts importRef={importRef} mediaId={mediaId} matched={matched} returnFocus={() => historySummary.current} />
        ) : null}
      </details>
      <details className={styles.diagnostics}>
        <summary>Diagnostics</summary>
        <dl>
          <Field label="Import">
            <code>{item.ref}</code>
          </Field>
          <Field label="Kind">{KIND_LABEL[item.media_kind]}</Field>
          {primary === null ? null : (
            <Field label="Stage">{stageLabel(primary.stage)}</Field>
          )}
          {primary?.code == null ? null : (
            <Field label="Code">
              <code>{primary.code}</code>
            </Field>
          )}
          <Field label="Accepted">
            <Moment value={item.accepted_at} />
          </Field>
          <Field label="Updated">
            <Moment value={item.updated_at} />
          </Field>
        </dl>
      </details>
    </div>
  );
}

/**
 * Recorded events as the attempts they belong to (upload generation, source
 * attempt, index revision, metadata operation), newest attempt first, each
 * newest event first.
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
    const group = groups.get(id) ?? { label, entries: [] };
    groups.set(id, group);
    group.entries.push(entry);
    if ("attempt_no" in facts)
      group.label = `Source attempt ${facts.attempt_no}`;
  }
  return [...groups];
}

/** Recorded events, retained across failed reads; a match can lie beyond the prefix. */
function Attempts({
  importRef,
  mediaId,
  matched,
  returnFocus,
}: {
  readonly importRef: string;
  readonly mediaId: string | null;
  readonly matched: ImportItem["matched_event"];
  readonly returnFocus: () => HTMLElement | null;
}) {
  const { observation, revision } = useImports();
  const history = useServerList<HistoryEntry>({
    key: `/imports/${importRef}/history`,
    stale: revision,
    pageSize: 50,
    active: usePaneIsActive(),
    visit: HISTORY,
    id: (entry) => entry.id,
    fetchPage: (cursor, limit, signal) => fetchImportHistory(importRef, cursor, limit, signal),
  });
  const { revalidate } = history;
  // A reopened visit can predate clocks observed while its disclosure was shut.
  const observed = useRef({ value: observation, restored: history.current });
  useEffect(() => {
    const previous = observed.current;
    observed.current = { value: observation, restored: false };
    if (observation !== "" && (previous.restored || previous.value !== observation)) revalidate();
  }, [observation, revalidate]);
  const error = history.failure?.error ?? null;
  const entries = history.items;
  const feedback = useCollectionReadFeedback({
    list: history, unit: HISTORY_UNIT, waiting: false, outcome: null, returnFocus,
  });
  const outside =
    matched !== null && !entries.some((entry) => entry.id === matched.id);
  const event = (entry: HistoryEntry) => (
    <HistoryEvent
      key={entry.id}
      entry={entry}
      mediaId={mediaId}
      matched={entry.id === matched?.id}
    />
  );
  let content: ReactNode;
  if (history.status === "loading") {
    content = <PaneLoadingState label="Loading history" announcement="None" />;
  } else if (gone(error)) {
    content = <FeedbackStatus content={{ tone: "Neutral", title: UNAVAILABLE_LINE }} announcement="Polite" />;
  } else if (history.status === "failed") {
    content = <FeedbackNotice
      content={loadFailure(error)}
      announcement="Polite"
      actions={[{ label: "try again", onClick: history.retry, busy: history.running !== null }]}
      returnFocus={returnFocus}
    />;
  } else {
    content = <>
      {error === null || history.failure?.op === "More" ? null : (
        <FeedbackNotice
          content={{
            ...loadFailure(error),
            tone: "Warning",
            title: "couldn’t refresh history",
            message: "showing the events already loaded",
          }}
          announcement="Polite"
          actions={[{ label: "try again", onClick: history.retry, busy: history.running !== null }]}
          returnFocus={returnFocus}
        />
      )}
      {outside ? (
        <section className={styles.attempt}>
          <h3 className={styles.attemptTitle}>Matched event</h3>
          <ol className={styles.attemptEvents}>{event(matched)}</ol>
        </section>
      ) : null}
      {history.complete && entries.length === 0 && !outside ? (
        <FeedbackStatus content={{ tone: "Neutral", title: "no recorded events" }} announcement="None" />
      ) : null}
      {attempts(entries).map(([id, group]) => (
        <section key={id} className={styles.attempt}>
          <h3 className={styles.attemptTitle}>{group.label}</h3>
          <ol className={styles.attemptEvents}>{group.entries.map(event)}</ol>
        </section>
      ))}
    </>;
  }
  return <>
    {content}
    {gone(error) ? null : feedback.notice}
    {feedback.announcement}
  </>;
}

function HistoryEvent({
  entry,
  mediaId,
  matched,
}: {
  readonly entry: HistoryEntry;
  readonly mediaId: string | null;
  readonly matched: boolean;
}) {
  const operation =
    entry.facts.kind === "MetadataOperation" ? entry.facts.operation : null;
  return (
    <li aria-current={matched ? "true" : undefined}>
      <span>{eventLine(entry)}</span>
      {mediaId !== null &&
      operation?.status === "no_findings" &&
      operation.reviewed_at === null ? (
        <MetadataReviewButton mediaId={mediaId} jobId={operation.job_id} />
      ) : null}
      {matched ? (
        <Pill tone="info" size="sm">
          <span aria-hidden="true">{MATCHED_LABEL}</span>
          <span className="sr-only">{MATCHED_ANNOUNCEMENT}</span>
        </Pill>
      ) : null}
      <Moment value={entry.occurred_at} />
      {operation === null ? null : <OperationDetails operation={operation} />}
    </li>
  );
}
