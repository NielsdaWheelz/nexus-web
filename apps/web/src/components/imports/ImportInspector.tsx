"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isApiError } from "@/lib/api/client";
import { formatDisplayDate } from "@/lib/display/format";
import type { ImportRef } from "@/lib/imports/importRef";
import { useImportDetail } from "@/lib/imports/useImportDetail";
import { useImportHistory } from "@/lib/imports/useImportHistory";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  IMPORT_UNAVAILABLE_LINE,
  historyCoverageLine,
  historyEventLine,
  historyMatchLine,
  importConsequenceLine,
  importKindLabel,
  importRecoveryRestrictionLine,
  importRecoveryScopeLine,
  importStageLabel,
  importStateLabel,
  importsLoadErrorMessage,
} from "@/lib/status/imports";
import { ImportActions } from "./ImportRow";
import { importHistoryGroups } from "./importsWorkspaceModel";
import styles from "./ImportsWorkspace.module.css";

/**
 * The inspected import, in the order a reader needs it: what this means for
 * them, what a recovery would reuse and repeat, the attempts that were actually
 * recorded, and the safe identifiers underneath (contract §6). It reads the
 * detail and the history itself, so the pane only has to name the selection.
 */
export default function ImportInspector({
  importRef,
}: {
  readonly importRef: ImportRef;
}) {
  const display = useRenderEnvironment();
  const detail = useImportDetail(importRef);
  const history = useImportHistory(importRef);

  if (detail.status === "error") {
    return isApiError(detail.error) && detail.error.code === "E_IMPORT_NOT_FOUND" ? (
      <p className={styles.inspectorEmpty}>{IMPORT_UNAVAILABLE_LINE}</p>
    ) : (
      <FeedbackNotice
        content={importsLoadErrorMessage(detail.error)}
        announcement="Assertive"
        actions={[{ label: "Try again", onClick: detail.retry }]}
      />
    );
  }
  if (detail.status !== "ready") {
    return <PaneLoadingState label="Loading this import" announcement="Polite" />;
  }

  const { item, readiness, historyCoverage } = detail.data;
  const recovery =
    item.capabilities.recovery.kind === "Present"
      ? item.capabilities.recovery.value
      : null;
  const restriction =
    item.capabilities.unavailableReason.kind === "Present"
      ? item.capabilities.unavailableReason.value
      : null;
  const matched =
    item.matchedEvent.kind === "Present"
      ? historyMatchLine(
          item.matchedEvent.value,
          formatDisplayDate(item.matchedEvent.value.occurredAt, display, {
            month: "short",
            day: "numeric",
          }) ?? item.matchedEvent.value.occurredAt,
        )
      : null;

  return (
    <div className={styles.inspector}>
      <PaneSection title={item.title}>
        <p className={styles.inspectorState}>
          <Pill
            tone={item.state.kind === "NeedsAttention" ? "warning" : "info"}
            size="sm"
          >
            {importStateLabel(item.state)}
          </Pill>
          <span>{importConsequenceLine(item, readiness)}</span>
        </p>
        {matched === null ? null : <p className={styles.rowMatched}>{matched}</p>}
      </PaneSection>

      <PaneSection title="Recovery">
        {recovery === null ? (
          <p>
            {restriction === null
              ? "No recovery is offered for this import."
              : importRecoveryRestrictionLine(restriction)}
          </p>
        ) : (
          <>
            <p>{importRecoveryScopeLine(recovery)}</p>
            <div className={styles.inspectorActions}>
              <ImportActions item={item} />
            </div>
          </>
        )}
      </PaneSection>

      <PaneSection
        title="Attempts"
        description={
          historyCoverage.kind === "Partial"
            ? historyCoverageLine(
                formatDisplayDate(historyCoverage.recordedSince, display, {
                  dateStyle: "medium",
                }) ?? historyCoverage.recordedSince,
              )
            : undefined
        }
      >
        {history.status === "error" ? (
          <FeedbackNotice
            content={importsLoadErrorMessage(history.error)}
            announcement="Polite"
            actions={[{ label: "Try again", onClick: history.retry }]}
          />
        ) : history.status === "loading" ? (
          <PaneLoadingState label="Loading recorded attempts" announcement="None" />
        ) : (
          <>
            {importHistoryGroups(history.entries).map((group) => (
              <section key={group.id} className={styles.attempt}>
                <h3 className={styles.attemptTitle}>{group.label}</h3>
                <ol className={styles.attemptEvents}>
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <span>{historyEventLine(entry)}</span>
                      <time dateTime={entry.occurredAt}>
                        {formatDisplayDate(entry.occurredAt, display, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }) ?? entry.occurredAt}
                      </time>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            <LoadMoreFooter
              hasMore={history.hasMore}
              loading={history.loadingMore}
              onLoadMore={history.loadMore}
              label="Load earlier events"
            />
          </>
        )}
      </PaneSection>

      <details className={styles.diagnostics}>
        <summary>Details</summary>
        <dl>
          <div>
            <dt>Import</dt>
            <dd>
              <code>{item.ref}</code>
            </dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{importKindLabel(item.mediaKind)}</dd>
          </div>
          {item.state.kind === "Complete" ? null : (
            <div>
              <dt>Stage</dt>
              <dd>{importStageLabel(item.state.stage)}</dd>
            </div>
          )}
          {item.state.kind === "NeedsAttention" &&
          item.state.failureCode.kind === "Present" ? (
            <div>
              <dt>Code</dt>
              <dd>
                <code>{item.state.failureCode.value}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Accepted</dt>
            <dd>
              <time dateTime={item.acceptedAt}>
                {formatDisplayDate(item.acceptedAt, display, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }) ?? item.acceptedAt}
              </time>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              <time dateTime={item.updatedAt}>
                {formatDisplayDate(item.updatedAt, display, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }) ?? item.updatedAt}
              </time>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
