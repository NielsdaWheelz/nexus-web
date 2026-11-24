"use client";

import { useCallback, useMemo, useState } from "react";
import type { QueryResult, RegisterItem } from "@nexus/authored/types";
import * as Icon from "@/lib/ui/icons";
import CollectionView, { type CollectionViewRowRenderProps } from "@/components/collections/CollectionView";
import type { CollectionRowView } from "@/lib/collections/types";
import CollectionRow from "@/components/collections/CollectionRow";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { Fact } from "@/components/feedback/Fact";
import { presentNote } from "@/lib/collections/presenters/note";
import { useAuthoredAccountId } from "@/lib/authored/provider";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { usePageOrder } from "@/lib/notes/pageOrder";
import { useRankedAuthoredWindow } from "@/lib/notes/rankedAuthoredWindow";
import type { RankedIndex } from "@/lib/collections/measuredIndexWindow";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { useRecent } from "@/lib/recent/store";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./NotesPaneBody.module.css";

const register = (result: QueryResult) => {
  const value = result.page_register;
  return value?.kind === "retained" || value?.kind === "successor" ? null : value;
};
const UNIT = {singular: "page", plural: "pages"};

/** Only mounted oversized titles need a read. Their identity, header and link already exist. */
function LongTitleRow(props: CollectionViewRowRenderProps) {
  const ref = props.row.resourceRef!;
  const read = useAuthoredQuery({kind: "register_label", ref});
  const result = read.data?.register_label;
  const title = result?.label ?? (result?.oversized ? "title too large to display" : read.error ? "couldn’t read title" : "page");
  return <CollectionRow {...props} row={{...presentNote({id: ref.slice(5), title}), id: props.row.id}}
    primaryControl={read.error ? <AuthoredReadFailure {...read} noun="this title"/> : props.primaryControl}/>;
}

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const type = readerType(useReaderProfile());
  const filter = usePaneFilterQuery("Notes.Pages");
  const text = filter.query.trim();
  const read = useAuthoredQuery({kind: "page_register", text, at: {kind: "describe"}, expected_revision: null});
  const account = useAuthoredAccountId();
  const raw = read.data?.page_register;
  const needsOrder = raw?.kind === "description" && raw.total > raw.items.length;
  const order = usePageOrder(text, needsOrder ? read.data!.store_revision : null);
  const admittedRead = needsOrder && order.data === null ? null : read.data;
  const [last, setLast] = useState<{account: typeof account; text: string; data: NonNullable<typeof read.data>; order: typeof order.data} | null>(null);
  if (admittedRead && (last?.account !== account || last.text !== text || last.data !== admittedRead || last.order !== order.data))
    setLast({account, text, data: admittedRead, order: order.data});
  const observation = admittedRead ?? (last?.account === account ? last.data : null);
  const shownText = admittedRead || last?.account !== account ? text : last.text;
  const shownOrder = admittedRead || last?.account !== account ? order.data : last.order;
  const shown = observation?.page_register;
  const description = shown?.kind === "description" ? shown : null;
  const revision = observation?.store_revision ?? null;
  const sparse = description !== null && description.total > description.items.length;
  const {items, positions, request, error: rangeError, retry: retryRange} = useRankedAuthoredWindow({kind: "page_register", text: shownText}, revision, description, register);
  const recent = useRecent();
  const refs = useMemo(() => shownText ? [] : (recent.snapshot?.entries ?? []).flatMap(({target}) =>
    target.kind === "resource_ref" && target.ref.startsWith("page:") ? [target.ref] : []), [shownText, recent.snapshot]);
  const recentRead = useAuthoredQuery(sparse && revision !== null && refs.length > 0
    ? {kind: "page_register", text: shownText, at: {kind: "locate", refs}, expected_revision: revision} : null);
  const locations = recentRead.data?.page_register;
  const opened = useMemo(() => {
    if (description === null || refs.length === 0) return [];
    const choices = sparse ? (locations?.kind === "locations" ? locations.items : []) : description.items;
    const byRef = new Map(choices.map(item => [item.ref, item]));
    return refs.flatMap(ref => byRef.has(ref) ? [byRef.get(ref)!] : []).slice(0, 8);
  }, [description, locations, refs, sparse]);
  const shift = opened.length;
  const groups = useMemo(() => {
    const heads = new Map<number, string>();
    if (shift > 0) heads.set(0, "recent");
    let start = shift;
    for (const size of description?.groups ?? []) { heads.set(start, "letter"); start += size; }
    const headSamples = new Map<string, React.ReactNode>([["letter", <h3 key="letter" className={styles.letter}>A</h3>]]);
    if (shift > 0) headSamples.set("recent", <h3 className={styles.recent}>opened here</h3>);
    return {heads, headSamples};
  }, [description?.groups, shift]);
  const list = useMemo(() => {
    const rows: CollectionRowView[] = [];
    const heads = new Map<string,string>(), long = new Set<string>();
    const ids = new Map<number, string>(), ranks = new Map<string, number>();
    const add = (item: RegisterItem, rank: number, isRecent: boolean) => {
      const id = item.ref.slice(5), row = presentNote({id, title: item.label ?? "page"});
      const occurrence = isRecent ? `recent:${id}` : id;
      if (item.label === null) long.add(occurrence);
      if (sparse) { ids.set(rank, occurrence); ranks.set(occurrence, rank); }
      rows.push({...row, id: occurrence});
      return occurrence;
    };
    for (const [rank, item] of opened.entries()) {
      const id = add(item, rank, true);
      if (rank === 0) heads.set(id, "opened here");
    }
    let previous: string | null = null;
    const ordered = sparse ? [...items].sort(([left], [right]) => left - right) : (description?.items ?? []).entries();
    for (const [rank, item] of ordered) {
      const id = add(item, rank + shift, false);
      if (!sparse && item.group !== previous) heads.set(id, item.group);
      previous = item.group;
    }
    return {rows, heads, long, ids, ranks};
  }, [description?.items, items, opened, shift, sparse]);
  const ranked = useMemo(() => {
    if (!sparse || description === null || revision === null) return undefined;
    const source: RankedIndex = {
      count: description.total + shift,
      revision: JSON.stringify([revision, opened.map(item => item.ref)]),
      heads: groups.heads,
      returnOrder: shownOrder === null ? undefined : {...shownOrder, prefix: opened.map(item => `recent:${item.ref.slice(5)}`)},
      failed: rangeError !== null,
      idAt: rank => list.ids.get(rank),
      rankOf(id) {
        const index = list.ranks.get(id);
        if (index !== undefined) return index;
        if (id.startsWith("recent:")) return null;
        const rank = positions?.get(`page:${id}`);
        return rank == null ? rank : rank + shift;
      },
      request(ranks, ids) {
        request(ranks.map(rank => rank - shift), ids.filter(id => !id.startsWith("recent:")).map(id => `page:${id}`));
      },
    };
    return {source, headSamples: groups.headSamples, headAt: (rank: number) => {
      if (rank === 0 && shift > 0) return <h3 className={styles.recent}>opened here</h3>;
      const label = items.get(rank - shift)?.group;
      return <h3 className={styles.letter} aria-hidden={label === undefined || undefined}>{label ?? "\u00a0"}</h3>;
    }};
  }, [description, groups, items, list, opened, positions, rangeError, request, revision, shift, shownOrder, sparse]);
  const error = read.error ?? order.error;
  const ready = (admittedRead !== null || error !== null) && (text !== "" || recent.snapshot !== null || recent.readFailure) &&
    (!sparse || refs.length === 0 || recentRead.data !== null || recentRead.error !== null);
  usePaneReturnReady(ready);
  const admitted = admittedRead?.page_register;
  const count = admitted?.kind === "description" ? admitted.total : 0;
  const total = admitted?.kind === "description" ? admitted.source_total : 0;
  usePaneChrome({
    primaryAction: {kind: "link", id: "NewPage", label: "New page", icon: <Icon.Add aria-hidden="true"/>, href: "/pages/new",
      onActivate: event => activateTargetLink({event, runtime, target: {href: "/pages/new"}, entry: {kind: "ComposePage", title: ""}})},
    query: {kind: "Collation", collation: {
      words: {label: "filter pages", value: filter.query, applied: filter.query, onChange: filter.onQueryChange,
        onClear: filter.clearQuery, standing: false, onSubmit: null, rows: {status: read.data
          ? {kind: "Complete", visibleCount: count, totalCount: total, unit: UNIT}
          : {kind: read.error ? "Failed" : "Partial", visibleCount: 0, loadedCount: 0, unit: UNIT}, announce: !!read.data && !read.error}, notice: null, verbs: []},
      dimensions: [], order: null, reset: null}},
    header: {kind: "Section", meta: read.data ? {kind: "Count", value: count, of: total, unit: "page"} : {kind: "Pending"}},
  });
  const headBefore = useCallback((row: CollectionRowView) => {
    const label = list.heads.get(row.id);
    return label === undefined ? null : <h3 className={row.id.startsWith("recent:") ? styles.recent : styles.letter}>{label}</h3>;
  }, [list.heads]);
  const failure = <AuthoredReadFailure {...(read.error ? read : order.error ? order : rangeError ? {error: rangeError, retry: retryRange} : recentRead)} noun="pages"/>;
  return <div {...type} className={styles.register}>
    <CollectionView returnScope="Notes.Pages" ariaLabel="Notes" rows={list.rows} geometry="UniformIndex" anchorKey={shownText}
      status={description ? "ready" : error ? "error" : "loading"} collectionBusy={!ready} ranked={ranked}
      notice={<>{description && (error || rangeError || recentRead.error) ? failure : null}
        {!text && recent.snapshot === null && recent.readFailure ? <Fact line={{fact: "couldn’t load recent items."}}
          verbs={[{label: "retry", commandKey: "retry recent", run: recent.read}]}/> : null}</>}
      error={!description ? failure : undefined}
      empty={<Fact line={{fact: shownText ? "no pages match this filter." : "no pages yet. daily pages stay in the journal."}}/>}
      renderRow={props => list.long.has(props.row.id) ? <LongTitleRow {...props}/> : <CollectionRow {...props}/>}
      headBefore={ranked === undefined ? headBefore : undefined}/>
  </div>;
}
