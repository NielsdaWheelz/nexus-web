"use client";

// Route chrome and page/day publication surround the shared outline surface.
import { useCallback, useEffect, useId, useMemo, type RefObject } from "react";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import CanonicalNoteEditor from "./CanonicalNoteEditor";
import PageTitleEditor from "./PageTitleEditor";
import OutlineSurface from "./OutlineSurface";
import type { NoteInspection } from "./NoteEditor";
import { WritingStatus } from "./NoteNotices";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { OutlineSessionScope } from "@/components/resources/ResourceOutlineList";
import type { Row } from "@/lib/notes/outline";
import { readText } from "@/lib/notes/texts";
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
  titleRef: RefObject<HTMLTextAreaElement | null>;
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
            <PageTitleEditor session={session} occurrence={{key: "", noteRef: source.item.ref}}
              content={source.content} editable={!filtering} label="page title" inputRef={titleRef}
              write={outline.setTitle} rootEnter={{label: outline.rows.length ? "focus first item" : "insert first item", execute: () => {
                const row = outline.rows[0];
                if (row) {
                  if (row.link.target.content.kind === "note") session.focusRow(row.key);
                  else session.selectOccurrence(row.key);
                } else {
                  const source = outline.insertionSource();
                  const position = session.position({endpoint: outline.endpoint, edgeId: null, side: "after"});
                  if (position) session.openComposer({source, position, occurrencePrefix: prefix, path: []}, outline.publication ?? undefined);
                }
              }}}/>

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
          {source.content.kind === "page" ? <WritingStatus textRef={source.item.ref} /> : null}
        </div>
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
          path={[]}
          insertionSource={outline.insertionSource()}
          filter={filter}
          sourceForRow={outline.insertionSource}
          publication={outline.publication ?? undefined}
          onRevealRoot={() => session.reveal({ kind: "root" })}
        />
        {!outline.complete ? (
          <button type="button" onClick={outline.more}>
            show more
          </button>
        ) : null}
      </section>
    </OutlineSessionScope>
  );
}
