"use client";

import { useEffect, useLayoutEffect, useRef, useState, type AnimationEventHandler } from "react";
import { Failed } from "@/components/feedback/Fact";
import CollectionView, { type CollectionViewRowRenderProps } from "@/components/collections/CollectionView";
import IndexedMediaRow from "@/components/collections/IndexedMediaRow";
import OpmlBatchRow from "@/components/feeds/OpmlBatchRow";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { usePaneFreeServerValue, useServerValue, type Visit } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import type { CollectionRowView } from "@/lib/collections/types";
import { dismissImports, fetchImportIndex, type ImportIndex } from "@/lib/imports/api";
import { registerDay } from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import { formatLocalDateInTimeZone, shiftLocalDate } from "@/lib/localDate";
import { requestNexusOpen } from "@/lib/nexus/events";
import { usePaneIsPresented } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { definePaneVisitDataKey, usePaneReturnReady, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";
import { importDetailsAction, importRecovery, recoveryCommand } from "./ImportActions";
import ImportWorkRow from "./ImportWorkRow";
import styles from "./Imports.module.css";

type Entry = ImportIndex["items"][number] | Schema<"OpmlImportSummaryOut">;
const VISIT = definePaneVisitDataKey<Visit<ImportIndex>>("Imports.Register");
const WINDOW = definePaneVisitDataKey<string>("Imports.From");

/** Find the first instant of the civil day, including zones whose midnight moves. */
function registerFrom(now: Date, timeZone: string): string {
  const today = formatLocalDateInTimeZone(now, timeZone);
  // justify-defect: imports uses the render environment's fixed supported display zone.
  if (today === null) throw new Error("display time zone is unavailable");
  const day = shiftLocalDate(today, -30);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let before = midnight - 24 * 60 * 60 * 1000;
  let after = midnight + 24 * 60 * 60 * 1000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    const date = formatLocalDateInTimeZone(new Date(middle), timeZone);
    // justify-defect: the same supported display zone owns each boundary comparison.
    if (date === null) throw new Error("display time zone is unavailable");
    if (date < day) before = middle;
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
  const { digest, revision } = useImports();
  const observing = useObservationDemand(usePaneIsPresented());
  const [indexDigest, setIndexDigest] = useState(digest);
  const register = useServerValue({ key: `/imports?${new URLSearchParams({ from })}`, stale: `${revision}:${indexDigest}`,
    visit: VISIT, enabled: observing, load: signal => fetchImportIndex(from, signal) });
  // A first summary that arrives during entry may ask for a fresh index after
  // adoption. It never aborts the cold read it was forbidden to gate.
  useEffect(() => {
    if (register.status !== "loading") setIndexDigest(digest);
  }, [register.status, digest]);
  const items = register.status === "ready" ? register.data.items : [];
  const batches = register.status === "ready" ? register.data.batches : [];
  const all = usePaneFreeServerValue({ key: "imports:all", stale: "",
    load: async signal => (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data.default_library_id });
  const entries = new Map<string, Entry>();
  for (const batch of batches.filter(batch => batch.state === "needs_attention")) entries.set(`opml:${batch.id}`, batch);
  for (const item of items.filter(item => item.classification === "NeedsAttention")) entries.set(item.ref, item);
  for (const batch of batches.filter(batch => batch.state !== "needs_attention")) entries.set(`opml:${batch.id}`, batch);
  for (const item of items.filter(item => item.classification !== "NeedsAttention")) entries.set(item.ref, item);

  const groups = new Map<string, string>();
  const rows: CollectionRowView[] = [];
  for (const [id, entry] of entries) {
    const item = "ref" in entry ? entry : null;
    const group = !("ref" in entry) ? entry.state === "needs_attention" ? "attention" : "active"
      : entry.classification === "NeedsAttention" ? "attention" : entry.classification === "Active" ? "active"
        : formatLocalDateInTimeZone(new Date(entry.arrived_at!), display.displayTimeZone);
    // justify-defect: imports uses the render environment's fixed supported display zone.
    if (group === null) throw new Error("display time zone is unavailable");
    groups.set(id, group);
    const arrived = item !== null && !("obligations" in item);
    rows.push({ id, kind: item === null ? "feed" : item.media_kind === "podcast_episode" ? "podcast_episode" : "media",
      presentation: "Index", title: { text: item?.title ?? "subscription import" },
      primary: arrived ? { kind: "link", href: `/media/${item.media_id}`, paneLabelHint: item.title } : { kind: "static" },
      contributors: [], publicationDate: null, context: null,
      resourceRef: arrived ? assumeCanonicalResourceRef(`media:${item.media_id}`) : null, selected: selected === id });
  }
  const established = useRef(false);
  const firstInGroup = new Set<string>();
  const heads = new Set<string>();
  for (const row of rows) {
    const group = groups.get(row.id)!;
    if (!heads.has(group)) { heads.add(group); firstInGroup.add(row.id); }
  }
  const { run } = useActionRuntime();
  const [retrying, setRetrying] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const retryable = items.flatMap(item => {
    if (!("obligations" in item)) return [];
    const offer = importRecovery(item);
    return offer === null || item.media_id === null ? [] : [{ mediaId: item.media_id, offer }];
  });
  const dismissible = items.flatMap(item => !("obligations" in item) || item.dismissal === null ? [] : [{ ref: item.ref, through: item.dismissal.through }]);
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
  const error = register.status === "loading" ? null : register.error;
  const failure = error === null ? null : <Failed error={error} noun="imports"
    retry={{ run: register.refetch, busy: register.status === "failed" ? register.retrying : register.status === "ready" && register.refreshing }} />;
  useLayoutEffect(() => {
    if (register.status === "ready") established.current = true;
  }, [register.status]);
  usePaneReturnReady(register.status !== "loading");
  const attentionCount = items.filter(item => item.classification === "NeedsAttention").length
    + batches.filter(batch => batch.state === "needs_attention").length;
  const activeCount = items.filter(item => item.classification === "Active").length
    + batches.filter(batch => batch.state !== "needs_attention").length;
  return <CollectionView returnScope="imports-register" anchorKey={from} rows={rows} ariaLabel="imports" geometry="UniformIndex"
    status={register.status === "failed" ? "error" : register.status} error={register.status === "failed" ? failure : null}
    notice={register.status === "ready" ? failure : null}
    empty={<p>nothing arrived in the last thirty days. <Button onClick={event => requestNexusOpen({ kind: "Import", into: [] }, event.currentTarget)}>import</Button></p>}
    headBefore={row => {
      if (!firstInGroup.has(row.id)) return null;
      const group = groups.get(row.id)!;
      const entry = entries.get(row.id)!;
      let heading: string;
      if (group === "attention") heading = `needs attention · ${attentionCount}`;
      else if (group === "active") heading = `importing · ${activeCount}`;
      else {
        if (!("ref" in entry) || entry.arrived_at === null) throw new Error("Arrival head has no instant");
        heading = registerDay(entry.arrived_at, new Date(), display.displayTimeZone);
      }
      return <><h3>{heading}</h3>
        {group !== "attention" ? null : <span className={styles.headActions}>
          {retryable.length < 2 ? null : <Button aria-disabled={retrying || undefined} aria-busy={retrying || undefined} onClick={() => void retryAll()}>{`retry ${retryable.length}`}</Button>}
          {dismissible.length < 2 ? null : <Button aria-disabled={dismissing || undefined} aria-busy={dismissing || undefined} onClick={() => void dismissAll()}>{`dismiss ${dismissible.length}`}</Button>}
        </span>}</>;
    }}
    renderRow={props => <RegisterRow {...props} entry={entries.get(props.row.id)!} group={groups.get(props.row.id)!}
      animate={established.current} onSelect={onSelect} />}
    footer={register.status === "ready" ? <>
      <p className={styles.colophon}>thirty days of arrivals. earlier ones are in all. {all.status === "ready" ? <a href={`/libraries/${all.data}`}>open all</a> : null}</p>
      {all.status === "failed" ? <Failed error={all.error} noun="all" retry={{ run: all.refetch, busy: all.retrying }} /> : null}
    </> : null}
  />;
}

/** A row's transition outlives reads and a change from pointer to library presentation. */
function RegisterRow({ entry, group, animate, onSelect, ...props }: CollectionViewRowRenderProps & {
  readonly entry: Entry;
  readonly group: string;
  readonly animate: boolean;
  readonly onSelect: (ref: string, trigger: HTMLElement | null) => void;
}) {
  const readable = "ref" in entry && (!("obligations" in entry) || entry.can_read || entry.can_play);
  const [motion, setMotion] = useState({ group, readable, fall: animate, ink: false });
  if (motion.group !== group || motion.readable !== readable) setMotion({ group, readable,
    fall: motion.fall || animate && motion.group !== group,
    ink: motion.ink || !motion.readable && readable });
  const onAnimationEnd: AnimationEventHandler<HTMLElement> = event => {
    if (event.target === event.currentTarget) setMotion(previous => ({ ...previous, fall: false }));
    else if (event.target instanceof Element && event.target.hasAttribute("data-row-title") &&
      event.target.closest("[data-collection-row-id]") === event.currentTarget)
      setMotion(previous => ({ ...previous, ink: false }));
  };
  const className = `${motion.fall ? styles.fall : ""} ${motion.ink ? styles.ink : ""}`;
  return "ref" in entry ? !("obligations" in entry)
    ? <IndexedMediaRow {...props} mediaId={entry.media_id} className={className} onAnimationEnd={onAnimationEnd} occurrenceActions={[importDetailsAction(entry, onSelect)]} />
    : <ImportWorkRow item={entry} selected={props.row.selected} onSelect={onSelect} className={className} onAnimationEnd={onAnimationEnd} listPosition={props.listPosition} />
    : <OpmlBatchRow batch={entry} selected={props.row.selected} onSelect={onSelect} className={className} onAnimationEnd={onAnimationEnd} listPosition={props.listPosition} />;
}
