"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Failed } from "@/components/feedback/Fact";
import CollectionView from "@/components/collections/CollectionView";
import CollectionRow from "@/components/collections/CollectionRow";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import OpmlBatchRow, { useOpmlBatches } from "@/components/feeds/OpmlBatchRow";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { dismissImports, fetchImportPage, type ImportItem } from "@/lib/imports/api";
import { registerDay } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { formatLocalDateInTimeZone, shiftLocalDate } from "@/lib/localDate";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { requestNexusOpen } from "@/lib/nexus/events";
import { usePaneIsPresented } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import { importDetailsAction, importRecovery, recoveryCommand } from "./ImportActions";
import ImportWorkRow from "./ImportWorkRow";
import styles from "./Imports.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<ImportItem>>("Imports.Register");
const WINDOW = definePaneVisitDataKey<string>("Imports.From");

/** Find the first instant of the civil day, including zones whose midnight moves. */
function registerFrom(now: Date, timeZone: string): string {
  const day = shiftLocalDate(formatLocalDateInTimeZone(now, timeZone), -30);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let before = midnight - 24 * 60 * 60 * 1000;
  let after = midnight + 24 * 60 * 60 * 1000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (formatLocalDateInTimeZone(new Date(middle), timeZone) < day) before = middle;
    else after = middle;
  }
  return new Date(after).toISOString();
}

/** One flat collection: attention, ongoing work, then thirty civil days of arrivals. */
export default function Register({ selected, onSelect }: {
  readonly selected: string | null;
  readonly onSelect: (ref: string, trigger: HTMLElement | null) => void;
}) {
  const display = useRenderEnvironment();
  const retainedFrom = usePaneVisitData(WINDOW, (): string => from);
  const [from] = useState(() => retainedFrom ?? registerFrom(new Date(), display.displayTimeZone));
  const { summary, digest, revision } = useImports();
  const active = useObservationDemand(usePaneIsPresented());
  const query = new URLSearchParams({ view: "Register", from }).toString();
  const list = useServerList({ key: digest === null ? null : `/imports?${query}`, stale: `${revision}:${digest}`,
    pageSize: 50, drain: false, active, visit: VISIT, id: (item: ImportItem) => item.ref,
    fetchPage: (cursor, limit, signal) => fetchImportPage(query, cursor, limit, signal) });
  const batches = useOpmlBatches();
  const all = usePaneFreeServerValue({ key: "imports:all", stale: "",
    load: async signal => (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data.default_library_id });
  const seeds = list.items.flatMap(item => {
    if (item.classification !== "Complete") return [];
    if (item.media_id === null || item.summary === null) throw new Error("Arrived import has no media summary");
    return [item.summary];
  });
  const summaries = useMediaSummaries(seeds);
  const unsettledBatches = batches.status === "ready" ? batches.data.filter(batch => batch.state === "needs_attention" || batch.state === "pending" || batch.state === "running") : [];
  const attentionLoaded = list.complete || list.items.some(item => item.classification !== "NeedsAttention");
  const entries = new Map<string, ImportItem | Schema<"OpmlImportSummaryOut">>();
  for (const batch of unsettledBatches.filter(batch => batch.state === "needs_attention")) entries.set(`opml:${batch.id}`, batch);
  for (const item of list.items.filter(item => item.classification === "NeedsAttention")) entries.set(item.ref, item);
  if (attentionLoaded) for (const batch of unsettledBatches.filter(batch => batch.state !== "needs_attention")) entries.set(`opml:${batch.id}`, batch);
  for (const item of list.items.filter(item => item.classification !== "NeedsAttention")) entries.set(item.ref, item);

  const groups = new Map<string, string>();
  const rows: CollectionRowView[] = [];
  for (const [id, entry] of entries) {
    const item = "ref" in entry ? entry : null;
    const group = !("ref" in entry) ? entry.state === "needs_attention" ? "attention" : "active"
      : entry.classification === "NeedsAttention" ? "attention" : entry.classification === "Active" ? "active"
        : formatLocalDateInTimeZone(new Date(entry.arrived_at!), display.displayTimeZone);
    groups.set(id, group);
    if (item?.classification === "Complete") {
      const resolved = summaries.resolve(item.summary!);
      if (resolved === null) { entries.delete(id); continue; }
      rows.push(presentMedia(resolved, { id, resourceRef: assumeCanonicalResourceRef(`media:${item.media_id}`),
        selected: selected === id, primary: { kind: "link", href: `/media/${item.media_id}` } }));
    } else rows.push({ id, kind: item === null ? "feed" : "media", presentation: "Index", title: { text: item?.title ?? "subscription import" },
      primary: { kind: "static" }, contributors: [], publicationDate: null, context: null, activity: null, exceptionalStatus: null, resourceRef: null, selected: selected === id });
  }
  const previous = useRef<Map<string, { group: string; readable: boolean }> | null>(null);
  useLayoutEffect(() => {
    if (list.status === "ready") previous.current = new Map([...entries].map(([id, entry]) => [id,
      { group: groups.get(id)!, readable: "ref" in entry && (entry.can_read || entry.can_play) }]));
  });
  const firstInGroup = new Set<string>();
  const heads = new Set<string>();
  for (const row of rows) {
    const group = groups.get(row.id)!;
    if (!heads.has(group)) { heads.add(group); firstInGroup.add(row.id); }
  }
  const { run } = useActionRuntime();
  const [retrying, setRetrying] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const retryable = list.items.flatMap(item => {
    const offer = importRecovery(item);
    return offer === null || item.media_id === null ? [] : [{ mediaId: item.media_id, offer }];
  });
  const dismissible = list.items.flatMap(item => item.dismissal === null ? [] : [{ ref: item.ref, through: item.dismissal.through }]);
  const retryAll = async () => {
    if (retrying) return;
    setRetrying(true);
    try { for (const { mediaId, offer } of retryable) await run(recoveryCommand(mediaId, offer)); }
    finally { setRetrying(false); }
  };
  const dismissAll = async () => {
    if (dismissing) return;
    setDismissing(true);
    try { await run({ ref: "imports", id: "Dismiss", label: ACTION_CATALOG.Dismiss.label, feedbackLabel: "dismiss", title: "imports",
      confirmation: null, tracked: true, execute: () => dismissImports(dismissible) }); }
    finally { setDismissing(false); }
  };
  const pendingMore = useRef(false);
  useEffect(() => {
    if (!pendingMore.current || list.running !== null || !list.fresh || list.failure !== null) return;
    pendingMore.current = false;
    if (!list.complete) list.more();
  }, [list]);
  const moreHeld = useRef(false);
  const colophon = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    if (list.complete && moreHeld.current && document.activeElement === document.body && colophon.current) {
      moreHeld.current = false;
      colophon.current.focus({ preventScroll: true });
    }
  });
  const feedback = useCollectionReadFeedback({ list, unit: { singular: "import", plural: "imports" }, waiting: list.status === "loading",
    outcome: list.complete && entries.size === 0 ? "nothing arrived in the last thirty days." : null });
  const batchError = batches.status !== "loading" && batches.error !== null ? <Failed error={batches.error} noun="subscription imports"
    retry={{ run: batches.refetch, busy: batches.status === "failed" ? batches.retrying : batches.refreshing }} /> : null;
  const failure = digest === null && summary.status === "failed" ? <Failed error={summary.error} noun="imports" retry={{ run: summary.refetch, busy: summary.retrying }} />
    : list.status === "failed" && list.failure !== null ? <Failed error={list.failure.error} noun="imports" retry={{ run: list.retry, busy: list.running !== null }} />
      : entries.size === 0 ? batchError : null;
  const loading = digest === null && summary.status !== "failed" || list.status === "loading" || batches.status === "loading";
  usePaneReturnReady(failure !== null || !loading);
  const count = (group: "attention" | "active") => (summary.status === "ready" ? group === "attention" ? summary.data.needs_attention_count : summary.data.active_count : 0)
    + unsettledBatches.filter(batch => (batch.state === "needs_attention") === (group === "attention")).length;
  return <>{feedback.announcement}<CollectionView returnScope="imports-register" anchorKey={from} rows={rows} ariaLabel="imports"
    status={failure !== null ? "error" : loading ? "loading" : "ready"} error={failure} notice={failure === batchError ? null : batchError}
    empty={<p>nothing arrived in the last thirty days. <Button onClick={event => requestNexusOpen({ kind: "Import", into: [] }, event.currentTarget)}>import</Button></p>}
    headBefore={row => {
      if (!firstInGroup.has(row.id)) return null;
      const group = groups.get(row.id)!;
      const entry = entries.get(row.id)!;
      let heading: string;
      if (group === "attention") heading = `needs attention · ${count("attention")}`;
      else if (group === "active") heading = `importing · ${count("active")}`;
      else {
        if (!("ref" in entry) || entry.arrived_at === null) throw new Error("Arrival head has no instant");
        heading = registerDay(entry.arrived_at, new Date(), display.displayTimeZone);
      }
      return <><h3>{heading}</h3>
        {group !== "attention" ? null : <span className={styles.headActions}>
          {retryable.length < 2 ? null : <Button aria-disabled={retrying || undefined} aria-busy={retrying || undefined} onClick={() => void retryAll()}>{attentionLoaded ? "retry all" : `retry ${retryable.length}`}</Button>}
          {dismissible.length < 2 ? null : <Button aria-disabled={dismissing || undefined} aria-busy={dismissing || undefined} onClick={() => void dismissAll()}>{attentionLoaded ? "dismiss all" : `dismiss ${dismissible.length}`}</Button>}
        </span>}</>;
    }}
    renderRow={props => {
      const entry = entries.get(props.row.id)!;
      const before = previous.current?.get(props.row.id);
      const fall = previous.current !== null && before?.group !== groups.get(props.row.id);
      const ink = "ref" in entry && before?.readable === false && (entry.can_read || entry.can_play);
      const className = `${fall ? styles.fall : ""} ${ink ? styles.ink : ""}`;
      return "ref" in entry ? entry.classification === "Complete"
        ? <CollectionRow {...props} className={className} occurrenceActions={[importDetailsAction(entry, onSelect)]} />
        : <ImportWorkRow item={entry} selected={props.row.selected} onSelect={onSelect} className={className} />
        : <OpmlBatchRow batch={entry} selected={props.row.selected} onSelect={onSelect} className={className} />;
    }}
    footer={<>{feedback.notice}
      {list.status !== "ready" ? null : !list.complete ? <Button aria-busy={list.running !== null || undefined}
        onFocus={() => { moreHeld.current = true; }} onBlur={event => { if (event.currentTarget.isConnected) moreHeld.current = false; }}
        onClick={() => { if (list.running !== null || !list.fresh) pendingMore.current = true; else list.more(); }}>load more</Button>
        : <><p className={styles.colophon}>thirty days of arrivals. earlier ones are in all. {all.status === "ready" ? <a ref={colophon} href={`/libraries/${all.data}`}>open all</a> : null}</p>
          {all.status === "failed" ? <Failed error={all.error} noun="all" retry={{ run: all.refetch, busy: all.retrying }} /> : null}</>}
    </>}
  /></>;
}
