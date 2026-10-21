"use client";

// Route chrome and page/day publication surround the shared outline surface.
import { useCallback, useEffect, useId, useMemo, useSyncExternalStore, type RefObject } from "react";
import { readWriting, subscribeWriting } from "@/lib/notes/journal";
import { Plus } from "lucide-react";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import CanonicalNoteEditor from "./CanonicalNoteEditor";
import OutlineSurface from "./OutlineSurface";
import type { NoteInspection } from "./NoteEditor";
import { NoteConflict, WritingStatus } from "./NoteNotices";
import Button from "@/components/ui/Button";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { OutlineSessionScope } from "@/components/resources/ResourceOutlineList";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { Row } from "@/lib/notes/outline";
import { flushText, readText, useText } from "@/lib/notes/texts";
import type { Outline } from "@/lib/notes/useOutline";
import type { PaneQuery } from "@/lib/panes/paneChrome";
import {
  matchesPaneFilterQuery,
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
  type PaneFilterRowsStatus as FilterRowsStatus,
} from "@/lib/panes/paneFilterRows";
import { endpointForResource } from "@/lib/resourceGraph/links";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import styles from "./OutlineEditor.module.css";

const rowFields = (row: Row): string[] => {
  const node = row.link.target;
  if (node.content.kind === "note") {
    const value = readText(node.item.ref)?.value;
    return [typeof value === "object" ? value.body_text : node.content.body_text];
  }
  return [
    node.item.label.trim() || node.item.ref.split(":")[0]!.replaceAll("_", " "),
    node.item.preview.source?.title ?? "",
  ];
};

/** The local filter counts loaded depth-zero items; completion follows the bounded read. */
export function useOutlineFilter(
  outline: Outline,
  sourceKey: string,
  inputLabel: string,
) {
  const fields = JSON.stringify(
    outline.rows.filter((row) => row.depth === 0).map(rowFields),
  );
  const status = outline.status;
  const complete = outline.complete;
  const getRowStatus = useCallback(
    (query: string): FilterRowsStatus => {
      const rows: string[][] = JSON.parse(fields);
      const visibleCount = rows.filter((row) =>
        matchesPaneFilterQuery(query, row),
      ).length;
      const unit = { singular: "item", plural: "items" };
      const count = rows.length;
      switch (status) {
        case "ready":
          return complete
            ? { kind: "Complete", visibleCount, totalCount: count, unit }
            : { kind: "Partial", visibleCount, loadedCount: count, unit };
        case "loading":
          return { kind: "Partial", visibleCount, loadedCount: count, unit };
        case "failed":
          return { kind: "Failed", visibleCount, loadedCount: count, unit };
      }
    },
    [complete, fields, status],
  );
  const { query, onQueryChange, clearQuery, rowStatus } = usePaneFilterRows({
    sourceKey,
    getRowStatus,
  });
  const statusId = useId();
  const linking = outline.activeReference !== null;
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryControls = useMemo<PaneQuery>(
    () => ({
      kind: "Controls",
      label: inputLabel,
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{
            label: inputLabel,
            placeholder: "Filter items",
            value: query,
            appliedValue: query,
            onChange: onQueryChange,
            onClear: clearQuery,
            disabled: linking,
          }}
          status={{
            placement: "Inline",
            id: statusId,
            visible: paneFilterRowsStatusVisible({
              status: rowStatus,
              filtering: query.trim() !== "",
            }),
            content: (
              <PaneFilterRowsStatus
                id={statusId}
                status={rowStatus}
                query={query}
              />
            ),
          }}
        />
      ),
    }),
    [
      clearQuery,
      focusInput,
      inputLabel,
      inputRef,
      linking,
      onQueryChange,
      query,
      rowStatus,
      statusId,
    ],
  );
  return { query, queryControls };
}

export default function OutlineEditor({
  outline,
  filter,
  inspection,
  titleRef,
}: {
  outline: Outline;
  filter: string;
  inspection: NoteInspection | null;
  titleRef: RefObject<HTMLInputElement | null>;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
}) {
  const source = outline.node(outline.endpoint) ?? outline.root!.source;
  const session = outline.session;
  const prefix = outline.occurrencePrefix;
  const insertion = endpointForResource(source.item.ref);
  const filtering = filter.trim() !== "";
  useEffect(() => {
    if (session.focus?.key === "" && source.content.kind === "page")
      titleRef.current?.focus();
  }, [session.focus, source.content.kind, titleRef]);
  return (
    <OutlineSessionScope session={session}>
      <section
        className={styles.outline}
        data-pane-return-scope="Notes.EditorBlocks"
      >
        <div className={styles.masthead}>
          {source.content.kind === "page" ? (
            <PageTitle outline={outline} textRef={source.item.ref} filtering={filtering} titleRef={titleRef} />
          ) : (
            <CanonicalNoteEditor
              session={session}
              occurrence={{ key: "", noteRef: source.item.ref }}
              continuation={
                insertion
                  ? {
                      source: insertion,
                      position: null,
                      occurrencePrefix: prefix,
                      path: [],
                    }
                  : null
              }
              label={`edit note: ${source.item.label}`}
              editable={!filtering}
              inspection={inspection}
              embeddedItem={
                source.content.kind === "note"
                  ? source.content.embedded_item
                  : null
              }
            />
          )}
          {session.view.zoom.length > 0 ? <ContextualActionMenu
            resourceRef={assumeCanonicalResourceRef(source.item.action_ref)}
            title={source.item.label}
            subjectKey={`outline:${outline.endpoint}:${source.item.ref}`}
            label={`more actions for ${source.item.label}`}
            sections={[]}
            commandDisabledReason={session.activeReference !== null ? "finish linking or return to prose first" : undefined}
          /> : null}
          {source.content.kind === "page" ? <WritingStatus textRef={source.item.ref} /> : null}
        </div>
        {session.view.zoom.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={session.activeReference !== null}
            onClick={outline.zoomOut}
          >
            back to linked notes
          </Button>
        ) : null}
        {filtering ? (
          <FeedbackStatus
            content={{
              tone: "Neutral",
              title: "filtered view is read only",
              message: "clear the filter to edit.",
            }}
            announcement="Polite"
          />
        ) : null}
        <OutlineSurface
          session={session}
          rows={outline.rows}
          endpoint={outline.endpoint}
          rootEndpoint={outline.endpoint}
          occurrencePrefix={prefix}
          path={session.view.zoom}
          filter={filter}
          sourceForRow={outline.insertionSource}
          publication={outline.publication ?? undefined}
          onRevealRoot={() => session.reveal({ kind: "root" })}
        />
        {!filtering &&
        session.activeReference === null &&
        !outline.rows.length &&
        source.content.kind === "page" &&
        outline.canInsert("start") ? (
          <button
            type="button"
            className={styles.insert}
            onClick={() => outline.insert("start")}
          >
            <Plus size={16} aria-hidden="true" />
            add a note
          </button>
        ) : null}
        {!outline.complete ? (
          <button type="button" onClick={outline.more}>
            show more
          </button>
        ) : null}
      </section>
    </OutlineSessionScope>
  );
}

/** Title input observes only its own field; outline projection never subscribes to typing. */
function PageTitle({ outline, textRef, filtering, titleRef }: {
  outline: Outline;
  textRef: string;
  filtering: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
}) {
  const text = useText(textRef);
  const paused = useSyncExternalStore(subscribeWriting, () => readWriting().paused, () => true);
  return <>
    <input ref={titleRef} className={styles.title} aria-label="Page title" maxLength={200}
      value={typeof text?.value === "string" ? text.value : ""}
      readOnly={paused || text?.ready !== true || filtering || outline.session.activeReference !== null}
      onBlur={() => flushText(textRef)}
      onChange={event => { if (!readWriting().paused && text?.ready) outline.setTitle(event.currentTarget.value); }}
      onKeyDown={event => {
        if (readWriting().paused || !text?.ready || event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing || filtering || outline.session.activeReference !== null) return;
        event.preventDefault();
        const row = outline.rows[0];
        if (row) outline.session.focusRow(row.key, "end", row.link.target.content.kind === "note" ? "text" : "reference");
        else outline.insert("start");
      }} />
    <NoteConflict textRef={textRef} />
  </>;
}
