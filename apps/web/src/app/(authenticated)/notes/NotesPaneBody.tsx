"use client";

// The register. The local account database owns it online and offline: undated pages in
// the query's ascii-folded title/ref order, a head on each letter's run, and above them
// the undated pages this device opened last. Filtering describes only the loaded prefix.
import * as Icon from "@/lib/ui/icons";
import { useMemo } from "react";
import { pageTitle } from "@nexus/authored/queries";
import CollectionView from "@/components/collections/CollectionView";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { Fact } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import { presentNote } from "@/lib/collections/presenters/note";
import { useAuthoredPages, useAuthoredQuery } from "@/lib/notes/hooks";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerType } from "@/lib/reader/typography";
import { useRecent } from "@/lib/recent/store";
import { usePaneReturnReady, usePaneScrollRetention } from "@/lib/workspace/paneReturnMemento";
import styles from "./NotesPaneBody.module.css";

const UNIT = { singular: "page", plural: "pages" };

/** sqlite's NOCASE folds ascii alone; a head under any wider fold would split a run. */
function letter(title: string): string {
  const first = String.fromCodePoint(title.codePointAt(0)!);
  return first >= "a" && first <= "z" ? first.toUpperCase() : first;
}

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const type = readerType(useReaderProfile());
  const read = useAuthoredPages({ kind: "pages", cursor: null, limit: 100 });
  const complete = read.data !== null && read.data.next_cursor === null;
  const rows = useMemo(() => (read.data?.rows ?? []).flatMap(({ resource }) => resource.kind === "page"
    ? [presentNote({ id: resource.ref.slice("page:".length), title: pageTitle(resource.title ?? "", resource.local_date) })] : []), [read.data]);
  const recentStore = useRecent();
  const recent = recentStore.snapshot;
  const recentRefs = useMemo(() => (recent?.entries ?? []).flatMap(({ target }) =>
    target.kind === "resource_ref" && target.ref.startsWith("page:") ? [target.ref] : []), [recent]);
  // Sorted, the query keeps its identity while only the recent order moves.
  const opened = useAuthoredQuery(recentRefs.length ? { kind: "resolve", refs: [...recentRefs].sort() } : null);
  const openedRows = useMemo(() => {
    const pages = new Map((opened.data?.rows ?? []).flatMap(({ resource }) =>
      resource.kind === "page" && resource.local_date === null ? [[resource.ref, resource] as const] : []));
    return recentRefs.flatMap(ref => {
      const page = pages.get(ref);
      const id = ref.slice("page:".length);
      return page ? [{ ...presentNote({ id, title: pageTitle(page.title ?? "", null) }), id: `recent:${id}` }] : [];
    }).slice(0, 8);
  }, [opened.data, recentRefs]);
  const listed = useMemo(() => [...openedRows, ...rows], [openedRows, rows]);
  usePaneReturnReady(read.data !== null || read.error !== null);
  usePaneScrollRetention(listed);
  const filter = usePaneFilterRows({
    sourceKey: "Notes.Pages",
    getRowStatus: query => {
      const visibleCount = rows.filter(row => matchesPaneFilterQuery(query, [row.title.text])).length;
      return complete
        ? { kind: "Complete", visibleCount, totalCount: rows.length, unit: UNIT }
        : { kind: read.error === null ? "Partial" : "Failed", visibleCount, loadedCount: rows.length, unit: UNIT };
    },
  });
  const filtering = filter.query.trim() !== "";
  const visible = rows.filter(row => matchesPaneFilterQuery(filter.query, [row.title.text]));
  usePaneChrome({
    primaryAction: { kind: "link", id: "NewPage", label: "New page", icon: <Icon.Add aria-hidden="true" />, href: "/pages/new",
      onActivate: event => activateTargetLink({ event, runtime, target: { href: "/pages/new" }, entry: { kind: "ComposePage", title: "" } }) },
    query: { kind: "Collation", collation: {
      words: { label: "filter pages", value: filter.query, applied: filter.query,
        onChange: filter.onQueryChange, onClear: filter.clearQuery, standing: false, onSubmit: null,
        rows: { status: filter.rowStatus, announce: read.data !== null && read.error === null }, notice: null, verbs: [] },
      dimensions: [], order: null, reset: null,
    } },
    header: { kind: "Section", meta: complete ? { kind: "Count", value: visible.length, of: rows.length, unit: "page" } : { kind: "Pending" } },
  });

  const runStarts = new Set<string>();
  let previous: string | null = null;
  for (const row of visible) {
    const head = letter(row.title.text);
    if (head !== previous) runStarts.add(row.id);
    previous = head;
  }
  const failure = <AuthoredReadFailure {...read} noun="pages"/>;
  // A cold failure of either recent read is said; an empty run is simply absent.
  const recentFailure = recent === null && recentStore.readFailure
    ? <Fact line={{ fact: "couldn’t load recent items." }} verbs={[{ label: "retry", commandKey: "retry recent", run: recentStore.read }]} />
    : opened.data === null && opened.error !== null ? <AuthoredReadFailure {...opened} noun="recent pages"/> : null;
  const emptyTitle = filtering
    ? complete ? "no pages match this filter." : "no loaded page matches this filter."
    : complete ? "no pages yet. daily pages stay in the journal." : "no pages loaded yet.";
  return <div {...type} className={styles.register}>
    <CollectionView
      returnScope="Notes.Pages" rows={filtering ? visible : [...openedRows, ...visible]} ariaLabel="Notes"
      status={read.data !== null ? "ready" : read.error !== null ? "error" : "loading"}
      collectionBusy={read.data === null && read.error === null}
      anchorKey={filter.query.trim()}
      notice={filtering ? !complete ? <p>filter applies to loaded pages.</p> : undefined : recentFailure ?? undefined}
      error={read.data === null ? failure : undefined}
      empty={<Fact line={{ fact: emptyTitle }} />}
      footer={!complete && read.data !== null ? <Button aria-busy={read.pending} onClick={read.more}>show more pages</Button> : undefined}
      headBefore={row => row.id === openedRows[0]?.id ? <h3 className={styles.recent}>opened here</h3>
        : runStarts.has(row.id) ? <h3 className={styles.letter}>{letter(row.title.text)}</h3> : null}
    />
  </div>;
}
