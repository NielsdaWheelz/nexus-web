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
import { useAuthoredIndex, useAuthoredQuery } from "@/lib/notes/hooks";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { useRecent } from "@/lib/recent/store";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./NotesPaneBody.module.css";

const UNIT = {singular: "page", plural: "pages"};
const register = (result: QueryResult) => result.page_register;

/** Only mounted oversized titles need a read. Their identity, header and link already exist. */
function LongTitleRow(props: CollectionViewRowRenderProps) {
  const ref = props.row.resourceRef!;
  const read = useAuthoredQuery({kind: "page_label", ref});
  const result = read.data?.page_label;
  const title = result?.label ?? (result?.oversized ? "title too large to display" : read.error ? "couldn’t read title" : "page");
  return <CollectionRow {...props} row={{...presentNote({id: ref.slice(5), title}), id: props.row.id}}
    primaryControl={read.error ? <AuthoredReadFailure {...read} noun="this title"/> : props.primaryControl}/>;
}

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const type = readerType(useReaderProfile());
  const filter = usePaneFilterQuery("Notes.Pages");
  const text = filter.query.trim();
  const read = useAuthoredIndex({kind: "page_register", text, start: 0, limit: 2048, expected_revision: null}, register);
  const account = useAuthoredAccountId();
  const [last, setLast] = useState<{account: typeof account; text: string; data: NonNullable<typeof read.data>} | null>(null);
  if (read.data && (last?.account !== account || last.text !== text || last.data !== read.data))
    setLast({account, text, data: read.data});
  const shown = read.data ?? (last?.account === account ? last.data : null);
  const shownText = read.data || last?.account !== account ? text : last.text;
  const recent = useRecent();
  const list = useMemo(() => {
    const rows = [], heads = new Map<string,string>(), long = new Set<string>();
    const items = shown?.items ?? [];
    let opened = 0;
    const add = (item: RegisterItem, isRecent: boolean) => {
      const id = item.ref.slice(5), row = presentNote({id, title: item.label ?? "page"});
      const occurrence = isRecent ? `recent:${id}` : id;
      if (item.label === null) long.add(occurrence);
      return {...row, id: occurrence};
    };
    if (!shownText && recent.snapshot) {
      const byRef = new Map(items.map(item => [item.ref,item]));
      for (const {target} of recent.snapshot.entries) {
        const item = target.kind === "resource_ref" ? byRef.get(target.ref) : null;
        if (!item) continue;
        const row = add(item, true);
        if (opened++ === 0) heads.set(row.id, "opened here");
        rows.push(row);
        byRef.delete(item.ref);
        if (opened === 8) break;
      }
    }
    let previous: string | null = null;
    for (const item of items) {
      const row = add(item, false);
      if (item.group !== previous) heads.set(row.id, item.group);
      rows.push(row); previous = item.group;
    }
    return {rows, heads, long};
  }, [shown, shownText, recent.snapshot]);
  const ready = (read.data !== null || read.error !== null) && (text !== "" || recent.snapshot !== null || recent.readFailure);
  usePaneReturnReady(ready);
  const count = read.data?.items.length ?? 0, total = read.data?.sourceTotal ?? 0;
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
  const failure = <AuthoredReadFailure {...read} noun="pages"/>;
  return <div {...type} className={styles.register}>
    <CollectionView returnScope="Notes.Pages" ariaLabel="Notes" rows={list.rows} geometry="UniformIndex" anchorKey={shownText}
      status={shown ? "ready" : read.error ? "error" : "loading"} collectionBusy={!ready}
      notice={<>{shown && read.error ? failure : null}
        {!text && recent.snapshot === null && recent.readFailure ? <Fact line={{fact: "couldn’t load recent items."}}
          verbs={[{label: "retry", commandKey: "retry recent", run: recent.read}]}/> : null}</>}
      error={!shown ? failure : undefined}
      empty={<Fact line={{fact: shownText ? "no pages match this filter." : "no pages yet. daily pages stay in the journal."}}/>}
      renderRow={props => list.long.has(props.row.id) ? <LongTitleRow {...props}/> : <CollectionRow {...props}/>}
      headBefore={headBefore}/>
  </div>;
}
