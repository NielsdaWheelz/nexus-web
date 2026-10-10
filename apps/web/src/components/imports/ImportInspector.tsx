"use client";

import type { ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import {
  fetchImportDetail,
  fetchImportHistory,
  usePagePrefix,
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
  recoveryLine,
  stageLabel,
  stateBadge,
} from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { ImportActions } from "./ImportRow";
import styles from "./Imports.module.css";

/** The server no longer has this import, or never had one by that ref. */
const gone = (error: ApiError | null) =>
  error?.code === "E_IMPORT_NOT_FOUND" || error?.code === "E_INVALID_REQUEST";

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
  const recovery = recoveryLine(item);
  // A media import's other actions live on its row; an upload's Remove is its
  // recovery when it has no offer (design §10 B9).
  const actionable =
    item.capabilities.recovery.kind === "Present" ||
    (item.media_ref.kind === "Absent" && item.capabilities.can_remove);
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
          <span>{consequenceLine(item, readiness.can_read)}</span>
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
      {recovery === null && !actionable ? null : (
        <PaneSection title="Recovery">
          {recovery === null ? null : <p>{recovery}</p>}
          {actionable ? (
            <div className={styles.inspectorActions}>
              <ImportActions item={item} />
            </div>
          ) : null}
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
      "generation" in facts
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
  updatedAt,
  matchedId,
}: {
  readonly importRef: string;
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
                {entry.id === matchedId ? (
                  <Pill tone="info" size="sm">
                    <span aria-hidden="true">{MATCHED_LABEL}</span>
                    <span className="sr-only">{MATCHED_ANNOUNCEMENT}</span>
                  </Pill>
                ) : null}
                <time dateTime={entry.occurred_at}>
                  {momentText(entry.occurred_at, display)}
                </time>
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
