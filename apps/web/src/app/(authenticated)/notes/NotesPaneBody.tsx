"use client";

// The local account database owns the index online and offline. Pages use one
// title/ref ordering; filtering describes only the loaded bounded prefix.
import { Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import { pageTitle } from "@nexus/authored/queries";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Input from "@/components/ui/Input";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { presentNote } from "@/lib/collections/presenters/note";
import { dailyDateFor } from "@/lib/notes/api";
import { useAuthoredPages } from "@/lib/notes/hooks";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { usePaneReturnReady, usePaneScrollRetention } from "@/lib/workspace/paneReturnMemento";
import type { WorkspaceTargetActivationRequest } from "@/lib/workspace/targetActivation";
import styles from "./notes.module.css";

const UNIT = { singular: "page", plural: "pages" };

export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const { calendarTimeZone } = useAuthenticatedAccount();
  const read = useAuthoredPages({ kind: "pages", cursor: null, limit: 100 });
  const complete = read.data !== null && read.data.next_cursor === null;
  const rows = useMemo(() => (read.data?.rows ?? []).flatMap(({ resource }) => resource.kind === "page"
    ? [presentNote({ id: resource.ref.slice("page:".length), title: pageTitle(resource.title ?? "", resource.local_date) })] : []), [read.data]);
  usePaneReturnReady(read.data !== null || read.error !== null);
  usePaneScrollRetention(rows);
  const filter = usePaneFilterRows({
    sourceKey: "Notes.Pages",
    getRowStatus: query => {
      const visibleCount = rows.filter(row => matchesPaneFilterQuery(query, [row.title.text])).length;
      return complete
        ? { kind: "Complete", visibleCount, totalCount: rows.length, unit: UNIT }
        : { kind: read.error === null ? "Partial" : "Failed", visibleCount, loadedCount: rows.length, unit: UNIT };
    },
  });
  const { inputRef, focusInput } = usePaneQueryInput();
  const statusId = useId();
  const visible = rows.filter(row => matchesPaneFilterQuery(filter.query, [row.title.text]));
  usePaneChrome({
    query: { kind: "Controls", label: "Filter pages", focusInput, content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter pages", placeholder: "Filter pages", value: filter.query, appliedValue: filter.query, onChange: filter.onQueryChange, onClear: filter.clearQuery }}
      status={{ placement: "Inline", id: statusId, visible: false, content: <PaneFilterRowsStatus id={statusId} status={filter.rowStatus} query={filter.query} announceQueryChanges={read.data !== null && read.error === null} /> }}
      onReset={filter.query ? filter.clearQuery : undefined}
    /> },
    header: { kind: "Section", meta: complete ? { kind: "Count", value: rows.length, unit: "page" } : { kind: "Pending" } },
  });

  const title = useResourceDraft("Notes.NewPageTitle", () => "");
  const titleInput = useRef<HTMLInputElement>(null);
  const setTitle = title.set;
  useEffect(() => { if (titleInput.current) setTitle(titleInput.current.value); }, [setTitle]);
  const todayHref = `/daily/${dailyDateFor({ kind: "Today" }, calendarTimeZone)}`;
  const openToday = (event: TargetActivationEvent) => activateTargetLink({ event, runtime, target: { href: todayHref } });
  const submit = (fork: boolean) => {
    const request: WorkspaceTargetActivationRequest = {
      originPaneId: runtime.paneId, target: { href: "/pages/new" },
      disposition: { kind: fork ? "Fork" : "Follow" },
      ...(title.read() ? { entry: { kind: "ComposePage", title: title.read() } } : {}),
    };
    const result = runtime.activateTarget(request);
    if (result.kind !== "Cancelled") title.set("");
    return result;
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") { event.preventDefault(); submit(true); }
  };
  const failure = read.error === null ? undefined : <FeedbackNotice
    content={{ tone: "Danger", title: "couldn’t open pages on this device" }} announcement="Assertive"
    actions={[{ label: "retry", onClick: read.retry }]}
  />;
  const emptyTitle = filter.query.trim()
    ? complete ? "no pages match this filter." : "no matching page found so far."
    : complete ? "no pages yet." : "no pages loaded so far.";
  return <CollectionView
    returnScope="Notes.Pages" rows={visible} ariaLabel="Notes"
    status={read.data !== null ? "ready" : read.error !== null ? "error" : "loading"}
    collectionBusy={read.data === null && read.error === null}
    anchorKey={filter.query.trim()}
    notice={<>{read.data === null ? null : failure}{filter.query.trim() && !complete ? <p>filter applies to loaded pages.</p> : null}</>}
    error={read.data === null ? failure : undefined}
    empty={<FeedbackNotice content={{ tone: "Neutral", title: emptyTitle }} announcement="None" />}
    footer={!complete && read.data !== null ? <Button onClick={read.more}>show more pages</Button> : undefined}
    toolbar={<>
      <form className={styles.toolbar} onSubmit={event => { event.preventDefault(); submit(false); }} onKeyDown={submitGesture}>
        <Input ref={titleInput} value={title.value} onChange={event => title.set(event.currentTarget.value)} onInput={event => title.set(event.currentTarget.value)} placeholder="New page" aria-label="New page title" style={{ flex: 1 }} />
        <Button emphasis="strong" iconOnly type="submit" aria-label="Create page" onClick={submitGesture} icon={<Plus size={16} aria-hidden="true" />} />
      </form>
      <ButtonLink href={todayHref} data-workspace-rich-target="true" onClick={openToday} onKeyDown={openToday}>Today</ButtonLink>
    </>}
  />;
}
