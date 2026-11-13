"use client";

import type { ReactNode } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import MetadataResearchActions from "@/components/media/MetadataResearchActions";
import MetadataResearchResult from "@/components/media/MetadataResearchResult";
import ButtonLink from "@/components/ui/ButtonLink";
import Button from "@/components/ui/Button";
import { useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import type { Schema } from "@/lib/api/wire";
import { SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import { fetchImportDetail, fetchImportHistory, type HistoryEntry, type ImportDetail, type ImportItem } from "@/lib/imports/api";
import { useImportCommands } from "@/lib/imports/commands";
import { eventLine, importFailureCopy, importLine, momentText, recoveryLine, registerDay, relatedSourceOutcomeLine, speaking, stageLabel, UNAVAILABLE_LINE, UPLOAD_REJECTED_LABEL } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { encodeImportsUrl } from "@/lib/imports/query";
import { METADATA_FAILURE_COPY, earlierMetadataRuns, metadataOperationName, metadataOperationSummary, metadataRetryBlockedCopy } from "@/lib/media/mediaMetadataCopy";
import { requirePaneRuntime, usePaneIsActive, usePaneIsPresented, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import { assertNever } from "@/lib/assertNever";
import { ImportCommandControl, ImportObligationActions, useDismissAction } from "./ImportActions";
import styles from "./ImportInspector.module.css";

const RECORD = definePaneVisitDataKey<ListSnapshot<HistoryEntry>>("Imports.Record");
const gone = (error: ApiError | null) => error?.code === "E_IMPORT_NOT_FOUND" || error?.code === "E_INVALID_REQUEST";

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Moment({ value }: { readonly value: string }) {
  const display = useRenderEnvironment();
  return <time dateTime={value}>{momentText(value, display).toLowerCase()}</time>;
}

/** Its surface's lifetime mounts both detail and record; the digest alone wakes them. */
export default function ImportInspector({ importRef }: { readonly importRef: string }) {
  const { summary, digest, revision } = useImports();
  const observing = useObservationDemand(usePaneIsPresented());
  const detail = usePaneFreeServerValue({ key: digest === null ? null : `/imports/${encodeURIComponent(importRef)}`,
    stale: `${revision}:${digest}`, enabled: observing, load: signal => fetchImportDetail(importRef, signal) });
  const active = usePaneIsActive();
  if (digest === null && summary.status === "failed") return <Failed error={summary.error} noun="imports" retry={{ run: summary.refetch, busy: summary.retrying }} />;
  if (detail.status === "loading") return <Ruling />;
  if (gone(detail.error)) return <Fact line={{ fact: UNAVAILABLE_LINE }} speak={active} />;
  if (detail.status === "failed") return <Failed error={detail.error} noun="import details" retry={{ run: detail.refetch, busy: detail.retrying }} />;
  return <>
    {detail.error === null ? null : <Failed error={detail.error} noun="updated import details" retry={{ run: detail.refetch, busy: detail.refreshing }} />}
    <Detail key={importRef} detail={detail.data} />
  </>;
}

/** A standing fact elaborates the cause and retry policy rather than repeating its row. */
function obligationFact(item: ImportItem, key: "source" | "search", at: (value: string) => string): string {
  const slot = item.obligations[key]!;
  switch (slot.classification) {
    case "NeedsAttention": return slot.failure_code === null
      ? key === "source" ? "this source couldn’t be read. no automatic retry." : "search preparation stopped. no automatic retry."
      : `${importFailureCopy(slot.failure_code).reason}. no automatic retry.`;
    case "Complete": throw new Error("Settled obligation has no standing fact");
    case "Active": break;
    default: return assertNever(slot.classification);
  }
  if (key === "search") return "nexus is preparing search for the saved text.";
  if (slot.waiting_reason === "AwaitingUploadConfirmation") return "nexus is waiting for the original file.";
  if (slot.next_retry_at !== null) return `nexus will try again at ${at(slot.next_retry_at)}.`;
  if (slot.status === "Queued") return item.can_read ? "nexus hasn’t started the refresh." : "nexus hasn’t started reading this source.";
  if (item.media_kind === "podcast_episode") return "nexus is preparing a transcript.";
  if (slot.progress?.kind === "Counted") return `reading ${slot.progress.unit.toLowerCase()} ${slot.progress.completed} of ${slot.progress.total}.`;
  const stage = slot.progress?.stage ?? slot.stage;
  switch (stage) {
    case "Validate": return "nexus is checking the file’s contents.";
    case "Finalize": return "nexus is preparing a readable copy.";
    case "Upload": case "Extract": case "SourceProcessing": return item.can_read ? "nexus is updating the saved source." : "nexus is reading the source.";
    case "Index": case "Metadata": throw new Error("Source obligation has another owner's stage");
    default: return assertNever(stage);
  }
}

function Detail({ detail }: { readonly detail: ImportDetail }) {
  const display = useRenderEnvironment();
  const runtime = requirePaneRuntime(usePaneRuntime(), "ImportInspector");
  const { item, source_issues: issues, related_imports: related, pending_captures: captures, original_source: original, email_source: email } = detail;
  const dismiss = useDismissAction(item);
  const metadata = item.obligations.metadata;
  const operation = metadata?.operation ?? null;
  const metadataUnsettled = metadata !== null && (metadata.unfinished_count > 0 || operation?.status === "failed" || operation?.status === "held");
  const at = (value: string) => new Intl.DateTimeFormat(display.displayLocale, { timeZone: display.displayTimeZone, timeStyle: "short" }).format(new Date(value)).toLowerCase();
  const primary = speaking(item);
  const title = item.can_read || item.can_play ? item.title : item.pointer ?? item.title;
  return <div className={styles.inspector}>
    <header className={styles.identity}>
      <h2>{title}</h2>
      {item.arrived_at === null ? null : <p>arrived {registerDay(item.arrived_at, new Date(), display.displayTimeZone)} at {at(item.arrived_at)}.</p>}
    </header>
    {(["source", "search"] as const).map(key => {
      const slot = item.obligations[key];
      if (slot === null || slot.classification === "Complete") return null;
      const restriction = recoveryLine(slot);
      return <section key={key} className={styles.section}>
        <h3>{key}{item.dismissed.includes(key) ? <span className={styles.dismissed}>dismissed</span> : null}</h3>
        <Fact line={{ fact: obligationFact(item, key, at) }} />
        {restriction === null ? null : <p>{restriction}</p>}
        {slot.recovery?.kind === "RetryUpload" && item.original_filename !== null ? <p>choose the original file: {item.original_filename}</p> : null}
        <div className={styles.actions}>
          <ImportObligationActions item={item} obligation={key} />
          {dismiss === null ? null : <ImportCommandControl action={dismiss} label="dismiss" />}
        </div>
      </section>;
    })}
    {metadataUnsettled ? <MetadataSection item={item} standing /> : null}
    {captures.length === 0 ? null : <section className={styles.section}><h3>pending captures</h3>
      {captures.map(capture => <PendingCapture key={capture.session_id} capture={capture} />)}
    </section>}
    {related.map(relation => {
      const sibling = relation.item;
      const line = importLine(sibling, display);
      const outcome = relatedSourceOutcomeLine(item, relation);
      const target: WorkspaceTarget = { href: `/imports?${encodeImportsUrl({ selected: sibling.ref })}`, secondaryActivation: { surfaceId: "import-detail" } };
      return <section key={sibling.ref} className={styles.section}>
        <h3>related {relation.relation}</h3><p>{sibling.can_read || sibling.can_play ? sibling.title : sibling.pointer ?? sibling.title}</p>
        {outcome === null ? null : <p>{outcome}</p>}
        {line === null ? null : <p>{line.text}</p>}
        <ButtonLink href={target.href} data-workspace-rich-target="true"
          onClick={event => activateTargetLink({ event, runtime, target })} onKeyDown={event => activateTargetLink({ event, runtime, target })}>view {relation.relation} import</ButtonLink>
      </section>;
    })}
    {issues.length === 0 ? null : <section className={styles.section}><h3>source quality</h3><SourceIssuesNotice issues={issues} /></section>}
    {metadataUnsettled ? null : <MetadataSection item={item} standing={false} />}
    <section className={styles.section}><h3>record</h3><Record importRef={item.ref} /></section>
    <section className={styles.section}><h3>particulars</h3>
      {email === null ? null : <div className={styles.email}><h4>received by email</h4>
        <p>{email.sender_name === null ? `from ${email.sender_address}` : `from ${email.sender_name} <${email.sender_address}>`}</p>
        {email.sent_at === null ? null : <p>sent <Moment value={email.sent_at} /></p>}
      </div>}
      <dl className={styles.particulars}>
        {original === null ? item.pointer === null || item.pointer === item.original_filename ? null : <Field label="source"><code>{item.pointer}</code></Field>
          : <Field label="source"><a href={original.source_url} target="_blank" rel="noopener noreferrer"><code>{original.source_label}</code></a></Field>}
        {item.original_filename === null ? null : <Field label="file"><code>{item.original_filename}</code></Field>}
        <Field label="ref"><code>{item.ref}</code></Field>
        {primary === null ? null : <Field label="stage"><code>{stageLabel(primary.stage)}</code></Field>}
        {primary?.code == null ? null : <Field label="code"><code>{primary.code}</code></Field>}
        <Field label="accepted"><Moment value={item.accepted_at} /></Field>
        <Field label="updated"><Moment value={item.updated_at} /></Field>
      </dl>
    </section>
  </div>;
}

function MetadataSection({ item, standing }: { readonly item: ImportItem; readonly standing: boolean }) {
  const display = useRenderEnvironment();
  const dismiss = useDismissAction(item);
  const metadata = item.obligations.metadata;
  if (metadata === null || item.media_id === null) return null;
  const operation = metadata.operation;
  const unfinished = metadata.unfinished_operation;
  const purpose = operation?.purpose ?? metadata.retry.purpose;
  const failed = operation?.status === "failed" || operation?.status === "held";
  const earlier = earlierMetadataRuns(metadata);
  const at = (value: string) => momentText(value, display).toLowerCase();
  let fact: string | null = `no recorded ${metadataOperationName(purpose)}.`;
  if (failed) fact = `${METADATA_FAILURE_COPY[operation.code]}. no automatic retry.`;
  else if (standing) {
    if (unfinished === null) throw new Error("Unsettled metadata has no operation");
    switch (unfinished.status) {
      case "held": fact = `${METADATA_FAILURE_COPY[unfinished.code]}. no automatic retry.`; break;
      case "waiting": fact = unfinished.until === null ? "nexus is waiting to try this research again." : `nexus will try again at ${at(unfinished.until)}.`; break;
      case "queued": fact = purpose === "title" ? "nexus hasn’t started finding a title." : "nexus hasn’t started researching this work’s bibliography."; break;
      case "running": fact = purpose === "title" ? "nexus is finding a title for the saved source." : "nexus is researching this work’s bibliography."; break;
      case "recovering": fact = `nexus is recovering the interrupted ${metadataOperationName(purpose)}.`; break;
      default: assertNever(unfinished);
    }
  } else if (operation !== null) fact = operation.status === "completed" && operation.outcome.purpose === "bibliography" ? null : `${metadataOperationSummary(operation, at)}.`;
  return <section className={styles.section}>
    <h3>{metadataOperationName(purpose)}{item.dismissed.includes("metadata") ? <span className={styles.dismissed}>dismissed</span> : null}</h3>
    {fact === null ? null : standing ? <Fact line={{ fact }} /> : <p>{fact}</p>}
    <MetadataResearchResult operation={operation} />
    {earlier > 0 ? <p>{earlier} earlier metadata {earlier === 1 ? "run remains" : "runs remain"} unfinished</p> : null}
    {unfinished !== null && unfinished.job_id !== operation?.job_id ? <p>{metadataOperationSummary(unfinished, at)} · <Moment value={unfinished.created_at} /></p> : null}
    {metadata.retry.status === "blocked" && !(metadata.retry.reason === "active" && unfinished !== null) ? <p>{metadataRetryBlockedCopy(metadata.retry)}</p> : null}
    <div className={styles.actions}><MetadataResearchActions mediaId={item.media_id} title={item.title} view={metadata} />
      {!standing || dismiss === null ? null : <ImportCommandControl action={dismiss} label="dismiss" />}
    </div>
  </section>;
}

function PendingCapture({ capture }: { readonly capture: Schema<"PendingCapture"> }) {
  const commands = useImportCommands();
  const busy = useBusyActionIds(`upload:${capture.session_id}`).has("RemoveUpload");
  let label: string;
  switch (capture.state) {
    case "AwaitingBytes": label = "waiting for the upload."; break;
    case "CapabilityExpired": label = "upload timed out."; break;
    case "VerificationFailed": label = capture.failure_code === null ? UPLOAD_REJECTED_LABEL : importFailureCopy(capture.failure_code).reason; break;
    default: return assertNever(capture.state);
  }
  return <div><p>{label} · <Moment value={capture.accepted_at} /></p>
    <Button aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { if (!busy) commands.discardCapture(capture.session_id); }}>discard capture</Button>
  </div>;
}

/** Attempt membership and event order come from the retained narration, never current jobs. */
function attempts(entries: readonly HistoryEntry[]) {
  const groups = new Map<string, { label: string; entries: HistoryEntry[] }>();
  for (const entry of entries) {
    const facts = entry.facts;
    const [id, label] = facts.kind === "MetadataOperation" ? [`Metadata:${facts.operation.job_id}`, metadataOperationName(facts.operation.purpose)]
      : "generation" in facts ? [`Upload:${facts.generation}`, `upload attempt ${facts.generation}`]
        : "source_attempt_id" in facts ? [`Source:${facts.source_attempt_id}`, "source attempt"]
          : [`Index:${facts.revision}`, `search index revision ${facts.revision}`];
    const group = groups.get(id) ?? { label, entries: [] };
    groups.set(id, group);
    group.entries.push(entry);
    if ("attempt_no" in facts) group.label = `source attempt ${facts.attempt_no}`;
  }
  return [...groups];
}

function Record({ importRef }: { readonly importRef: string }) {
  const { digest, revision } = useImports();
  const active = useObservationDemand(usePaneIsPresented());
  const history = useServerList({ key: digest === null ? null : `/imports/${importRef}/history`, stale: `${revision}:${digest}`,
    pageSize: 50, active, visit: RECORD, id: (entry: HistoryEntry) => entry.id,
    fetchPage: (cursor, limit, signal) => fetchImportHistory(importRef, cursor, limit, signal) });
  const error = history.failure?.error ?? null;
  const feedback = useCollectionReadFeedback({ list: history, unit: { singular: "event", plural: "events" }, waiting: false, outcome: null });
  if (history.status === "loading") return <Ruling />;
  if (gone(error)) return <Fact line={{ fact: UNAVAILABLE_LINE }} />;
  if (history.status === "failed") return <Failed error={error} noun="record" retry={{ run: history.retry, busy: history.running !== null }} />;
  return <>
    {history.failure?.op === "Refetch" ? <Failed error={history.failure.error} noun="updated record" retry={{ run: history.retry, busy: history.running !== null }} /> : null}
    {history.complete && history.items.length === 0 ? <Fact line={{ fact: "no events recorded." }} /> : null}
    {attempts(history.items).map(([id, group]) => <section key={id} className={styles.attempt}>
      <h4>{group.label}</h4><ol className={styles.events}>{group.entries.map(entry => <li key={entry.id}>
        <span>{eventLine(entry)}</span><Moment value={entry.occurred_at} />
        <MetadataResearchResult operation={entry.facts.kind === "MetadataOperation" ? entry.facts.operation : null} />
      </li>)}</ol>
    </section>)}
    {feedback.notice}{feedback.announcement}
  </>;
}
