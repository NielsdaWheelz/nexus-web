"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { isApiError } from "@/lib/api/client";
import type { ImportRef } from "@/lib/imports/importRef";
import type { HistoryEntry } from "@/lib/imports/importsClient";
import { useImportDetail } from "@/lib/imports/useImportDetail";
import { useImportHistory } from "@/lib/imports/useImportHistory";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  IMPORT_MATCHED_ATTEMPT_LABEL,
  IMPORT_UNAVAILABLE_LINE,
  historyCoverageLine,
  historyEventLine,
  historyMatchLine,
  importConsequenceLine,
  importKindLabel,
  importMomentText,
  importRecoveryAbsenceLine,
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
 * detail and the history itself, so the pane only has to name the selection and
 * the event the open view matched it on.
 */
export default function ImportInspector({
  importRef,
  matchedEvent,
}: {
  readonly importRef: ImportRef;
  /**
   * The event the open view matched this import on, or null when it matched
   * none. The detail read has no filter to correlate, so this fact reaches the
   * inspector from the listed row rather than from the read below.
   */
  readonly matchedEvent: HistoryEntry | null;
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
    matchedEvent === null
      ? null
      : historyMatchLine(matchedEvent, display, new Date());
  const recoveryLine =
    recovery !== null
      ? importRecoveryScopeLine(recovery)
      : restriction !== null
        ? importRecoveryRestrictionLine(restriction)
        : importRecoveryAbsenceLine(item.state);

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

      {recoveryLine === null ? null : (
        <PaneSection title="Recovery">
          <p>{recoveryLine}</p>
          {recovery === null ? null : (
            <div className={styles.inspectorActions}>
              <ImportActions item={item} />
            </div>
          )}
        </PaneSection>
      )}

      <PaneSection
        title="Attempts"
        description={
          historyCoverage.kind === "Partial"
            ? historyCoverageLine(historyCoverage.recordedSince, display)
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
                  {group.entries.map((entry) => {
                    const isMatch =
                      matchedEvent !== null && entry.id === matchedEvent.id;
                    return (
                      <li
                        key={entry.id}
                        aria-current={isMatch ? "true" : undefined}
                      >
                        <span>{historyEventLine(entry)}</span>
                        {isMatch ? (
                          <Pill tone="info" size="sm">
                            {IMPORT_MATCHED_ATTEMPT_LABEL}
                          </Pill>
                        ) : null}
                        <time dateTime={entry.occurredAt}>
                          {importMomentText(entry.occurredAt, display)}
                        </time>
                      </li>
                    );
                  })}
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
                {importMomentText(item.acceptedAt, display)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              <time dateTime={item.updatedAt}>
                {importMomentText(item.updatedAt, display)}
              </time>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
