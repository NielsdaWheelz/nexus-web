"use client";

// An outline pane's editing surface: the masthead (the page title, or the root note),
// its rows (note editors, resource cards, "Already shown above" returns), block
// selection, drag, row creation, menus and inline references. a pane filter makes it a
// read-only inspection of the loaded rows.
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { Plus } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor, { type NoteInspection } from "@/components/notes/NoteEditor";
import { NoteConflict, WritingStatus } from "@/components/notes/NoteNotices";
import ActionMenu from "@/components/ui/ActionMenu";
import Tooltip from "@/components/ui/Tooltip";
import Button from "@/components/ui/Button";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { NoteBody } from "@/lib/notes/noteBody";
import { indentParent, isNoteRow, structuralRow, siblingsOf, type Row } from "@/lib/notes/outline";
import { flushText, useText } from "@/lib/notes/texts";
import type { InsertAt, Outline } from "@/lib/notes/useOutline";
import type { PaneQuery } from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery, paneFilterRowsStatusVisible, usePaneFilterRows, type PaneFilterRowsStatus as FilterRowsStatus } from "@/lib/panes/paneFilterRows";
import { activateResource } from "@/lib/resources/activation";
import type { ResourceItem } from "@/lib/resources/items";
import ResourceOutlineList, { ResourceOutlineContext } from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { endpointForResource } from "@/lib/resourceGraph/links";
import { useResourceOutline } from "@/lib/resourceGraph/useResourceOutline";
import { ResourceComposer } from "@/components/resources/ResourceDisclosure";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import {
  ClipboardWriteUnavailableError,
  copyResourceLink,
  copyText,
} from "@/lib/ui/copyText";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import styles from "./OutlineEditor.module.css";

type Activate = (input: {
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
}) => void;
type Placement = "before" | "after" | "inside";

const rowFields = (row: Row): string[] => {
  const node = row.link.target;
  if (node.content.kind === "note") return [node.content.body_text];
  return [node.item.label.trim() || node.item.ref.split(":")[0]!.replaceAll("_", " "), node.item.preview.source?.title ?? ""];
};

/** The local filter counts loaded depth-zero items; completion follows the bounded read. */
export function useOutlineFilter(outline: Outline, sourceKey: string, inputLabel: string) {
  const fields = JSON.stringify(outline.rows.filter((row) => row.depth === 0).map(rowFields));
  const status = outline.status;
  const complete = outline.complete;
  const getRowStatus = useCallback(
    (query: string): FilterRowsStatus => {
      const rows: string[][] = JSON.parse(fields);
      const visibleCount = rows.filter((row) => matchesPaneFilterQuery(query, row)).length;
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
  const { query, onQueryChange, clearQuery, rowStatus } = usePaneFilterRows({ sourceKey, getRowStatus });
  const statusId = useId();
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryControls = useMemo<PaneQuery>(
    () => ({
      kind: "Controls",
      label: inputLabel,
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: inputLabel, placeholder: "Filter items", value: query, appliedValue: query, onChange: onQueryChange, onClear: clearQuery }}
          status={{ placement: "Inline", id: statusId, visible: paneFilterRowsStatusVisible({ status: rowStatus, filtering: query.trim() !== "" }), content: <PaneFilterRowsStatus id={statusId} status={rowStatus} query={query} /> }}
        />
      ),
    }),
    [clearQuery, focusInput, inputLabel, inputRef, onQueryChange, query, rowStatus, statusId],
  );
  return { query, queryControls };
}

export default function OutlineEditor({
  outline,
  filter,
  inspection,
  titleRef,
  activateTarget,
}: {
  outline: Outline;
  filter: string;
  inspection: NoteInspection | null;
  titleRef: RefObject<HTMLInputElement | null>;
  activateTarget: Activate;
}) {
  const source = outline.node(outline.endpoint) ?? outline.root!.source;
  const filtering = filter.trim() !== "";
  const [focusedBranch, setFocusedBranch] = useState<string | null>(null);
  const selectable = focusedBranch === null;
  const editable = !filtering && selectable;
  const committing=editable && outline.activeReference===null;
  const feedback = useFeedback();
  const section = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: string | null; placement: Placement } | null>(null);
  const selection = outline.selection;
  const selected = selection?.kind === "blocks" ? selection.keys : [];
  const projectedRows = focusedBranch === null ? outline.rows : outline.projectRows(focusedBranch);
  const rows = useMemo(
    () => (filtering ? projectedRows.filter((row) => { const root = projectedRows.find((candidate) => candidate.depth === 0 && (candidate.key === row.key || row.key.startsWith(`${candidate.key}/`))); return root && matchesPaneFilterQuery(filter, rowFields(root)); }) : projectedRows),
    [filter, filtering, projectedRows],
  );
  const warn = useCallback(
    (title: string, message?: string) => feedback.offer({ key: "outline-action", announcement: "Polite", content: { tone: "Warning", title, message } }),
    [feedback],
  );
  // A return to the root focuses the masthead; the root note's editor takes it itself.
  const focus = outline.focus;
  useEffect(() => {
    if (focus?.key !== "" || source.content.kind !== "page") return;
    titleRef.current?.focus();
  }, [focus, source.content.kind, titleRef]);

  // history can restore blocks; only that transition may reclaim focus from a row action.
  useLayoutEffect(() => {
    if (selection?.kind === "blocks") section.current?.focus();
  }, [selection]);

  const selectBlock = (key: string, extend = false) => {
    outline.select(key, extend);
    window.getSelection()?.removeAllRanges();
    section.current?.focus();
  };

  const onBlockKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== section.current || !selectable || outline.activeReference !== null) return;
    const key = event.key;
    const mac = navigator.platform.toLowerCase().includes("mac");
    const mod = mac ? event.metaKey : event.ctrlKey;
    const handled = () => event.preventDefault();
    if ((mod && key.toLowerCase() === "z") || (!mac && event.ctrlKey && key.toLowerCase() === "y")) {
      handled();
      if (!editable) return;
      return event.shiftKey || key.toLowerCase() === "y" ? outline.redo() : outline.undo();
    }
    if (!selected.length) return;
    const current = selected.length === 1 || selected[0] === outline.selection?.anchor ? selected.at(-1) : selected[0];
    const index = rows.findIndex((row) => row.key === current);
    const row = rows[index];
    if (!row) return;
    if (key === "Tab") {
      handled();
      const insert = !event.shiftKey && selected.length === 1
        ? section.current?.querySelector<HTMLButtonElement>(`[data-note-insert-after="${CSS.escape(row.key)}"]:not(:disabled)`)
        : null;
      if (insert) insert.focus();
      else leave(section.current!, event.shiftKey);
      return;
    }
    if (key === "Escape") return void (handled(), outline.clearSelection());
    if (key === "Enter") {
      if (row.terminal === null && !isNoteRow(row)) {
        const activation = workspaceTargetActivationIntent(event, "activate");
        if (activation.kind === "Unowned") return;
        handled();
        if (activation.kind === "Open") activateResource(row.link.target.item.activation, {
          labelHint: row.link.target.item.label,
          disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" },
          activateTarget,
        });
        return;
      }
      handled();
      if (row.terminal !== null) return outline.reveal(row.terminal);
      return outline.focusRow(row.key);
    }
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    const up = key === "ArrowUp";
    if (vertical && editable && event.shiftKey && (mac ? event.metaKey : event.altKey)) {
      handled();
      return selected.length === 1 ? outline.move(row, up ? -1 : 1) : undefined;
    }
    if (vertical && editable && mod) {
      handled();
      return row.open === up && isNoteRow(row) ? outline.toggle(row) : undefined;
    }
    if (vertical) {
      handled();
      const next = rows[index + (up ? -1 : 1)];
      return next ? outline.select(next.key, event.shiftKey) : undefined;
    }
    if (editable && (key === "Backspace" || key === "Delete")) {
      handled();
      outline.remove(rows.filter((r) => selected.includes(r.key)));
    }
  };

  const childrenByParent = useMemo(() => {
    const groups = new Map<string, { row: Row; index: number }[]>();
    rows.forEach((row, index) => {
      const key = row.depth === 0 ? "" : row.path.slice(0, -1).join("/");
      const group = groups.get(key) ?? [];
      group.push({ row, index });
      groups.set(key, group);
    });
    return groups;
  }, [rows]);
  const renderRows = (parent: Row | null): ReactNode => (childrenByParent.get(parent?.key ?? "") ?? []).map(({ row, index }) => (
    <OutlineRow key={row.key} row={row} index={index} outline={outline} editable={editable} canCreate={!filtering} selectable={selectable} focusedBranch={focusedBranch} selected={selected.includes(row.key)}
      drop={drag?.over === row.key ? drag.placement : null}
      onDragStart={() => setDrag({ key: row.key, over: null, placement: "after" })}
      onDragOver={(placement) => drag && drag.key !== row.key && setDrag({ ...drag, over: row.key, placement })}
      onDragEnd={() => setDrag(null)}
      onDrop={() => { const from = outline.rows.find((r) => r.key === drag?.key); if (from && drag?.over === row.key) outline.drop(from, row, drag.placement); setDrag(null); }}
      onSelect={(extend) => selectBlock(row.key, extend)} warn={warn}
      childrenRows={<ResourceOutlineList scope={`notes:${row.key}`} ariaLabel="Ordered linked notes">{renderRows(row)}</ResourceOutlineList>}
    />
  ));

  return (
    <section
      ref={section}
      className={styles.outline}
      aria-label="Linked notes"
      data-pane-return-scope="Notes.EditorBlocks"
      tabIndex={-1}
      onKeyDown={onBlockKey}
      onFocus={(event) => {
        // a row's text taking focus ends block selection.
        if (selected.length && event.target.isContentEditable) outline.clearSelection();
      }}
      onCopy={(event) => {
        if (event.target !== section.current || !selectable || !selected.length) return;
        event.preventDefault();
        outline.copy(event.clipboardData, false);
      }}
      onCut={(event) => {
        if (event.target !== section.current || !editable || !selected.length) return;
        event.preventDefault();
        outline.copy(event.clipboardData, true);
      }}
      onPaste={(event) => {
        if (event.target !== section.current || !editable || !selected.length) return;
        event.preventDefault();
        try {
          outline.paste(event.clipboardData);
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
          warn("Paste not applied", error instanceof TypeError ? error.message : "The copied outline is unreadable.");
        }
      }}
    >
      <div className={styles.masthead}>
        {source.content.kind === "page" ? (
          <Title textRef={source.item.ref} inputRef={titleRef} outline={outline} editable={committing} />
        ) : (
          <div className={styles.noteHead}><div className={styles.editor}><RowText
            textRef={source.item.ref}
            rowKey=""
            label="Note content"
            outline={outline}
            editable={editable && (outline.activeReference===null || outline.activeReference==="")}
            inspection={inspection}
            embeddedItem={source.content.kind === "note" ? source.content.embedded_item : null}
          /></div>{source.content.kind === "note" && editable ? <InsertNoteButton outline={outline} at="end" label="add linked note" /> : null}</div>
        )}
        <WritingStatus />
      </div>
      {outline.failedIntents.length > 0 ? <section aria-label="kept outline drafts">
        <p role="alert">this change was refused. your drafts are kept.</p>
        {outline.failedIntents.map((intent, index) => <div key={index}>
          {intent.placements.map((place, position) => <p key={position}>in {place.source}, after {place.after}</p>)}
          {intent.drafts.map((draft) => <div key={draft.ref}>
            <NoteEditor editorKey={`failed:${index}:${draft.ref}`} body={draft.body} revision={0} editable={false} label="kept note draft" history={null} containingNoteRef={null} onEdit={()=>undefined} />
            <button type="button" onClick={()=>void copyText(draft.body.body_text).catch(()=>warn("copy unavailable"))}>copy text</button>
          </div>)}
          {index === 0 ? <>
            {intent.problem ? <p>{intent.problem}</p> : <p>review the refreshed source and predecessor before retrying</p>}
            <button type="button" disabled={intent.problem!==null} onClick={outline.retryFailed}>retry this change at the reviewed position</button>
          </> : <p>review the earlier kept change first</p>}
        </div>)}
      </section> : null}
      {outline.zoomed ? (
        <Button variant="ghost" size="sm" onClick={outline.zoomOut}>
          Back to linked notes
        </Button>
      ) : null}
      {filtering ? (
        <FeedbackStatus content={{ tone: "Neutral", title: "filtered view is read only", message: "clear the filter to edit." }} announcement="Polite" />
      ) : null}
      {outline.zoomed && selectable ? <BranchStatus outline={outline} resourceRef={outline.endpoint} /> : null}
      <ResourceOutlineList scope={`notes:${outline.endpoint}`} ariaLabel="Note items" ancestorRef={outline.endpoint}
        onRevealRoot={() => outline.reveal({ kind: "root" })}
        onFocusChange={(focused) => { setFocusedBranch(focused); if (focused !== null) { outline.clearSelection(); setDrag(null); } }}
        >
        {renderRows(null)}
        {filtering && outline.status === "ready" && outline.complete && !rows.length ? <li className={styles.empty}><FeedbackStatus content={{ tone: "Neutral", title: "no items match this filter" }} announcement="Polite" /></li> : null}
        {committing && source.content.kind === "page" && !outline.rows.length && outline.canInsert("start") ? <li className={styles.insertion}><button type="button" className={styles.insert} onClick={()=>outline.insert("start")}><Plus size={16} aria-hidden="true" />add a note</button></li> : null}
      </ResourceOutlineList>
      {!outline.zoomed && !outline.complete ? <button type="button" onClick={outline.more}>show more</button> : null}
    </section>
  );
}

/** leave block selection for the next (or previous) focusable outside the outline. */
function leave(section: HTMLElement, back: boolean) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const outside = [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => !section.contains(element) && element.getClientRects().length > 0,
  );
  const position = (element: HTMLElement) => section.compareDocumentPosition(element);
  const target = back
    ? outside.filter((element) => position(element) & Node.DOCUMENT_POSITION_PRECEDING).at(-1)
    : outside.find((element) => position(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  target?.focus();
}

function InsertNoteButton({
  outline,
  at,
  label,
  tooltip = label,
}: {
  outline: Outline;
  at: InsertAt;
  label: string;
  tooltip?: string;
}) {
  return (
    <Tooltip
      text={tooltip}
      renderTrigger={(props) => (
        <Button
          {...props}
          variant="ghost"
          size="sm"
          iconOnly
          className={styles.insertNote}
          aria-label={label}
          data-row-hover-action="true"
          data-note-insert-after={
            typeof at === "object" ? at.afterRowKey : undefined
          }
          disabled={!outline.canInsert(at)}
          onClick={() => outline.insert(at)}
        >
          <Plus size={16} aria-hidden="true" />
        </Button>
      )}
    />
  );
}

function Title({
  textRef,
  inputRef,
  outline,
  editable,
}: {
  textRef: string;
  inputRef: RefObject<HTMLInputElement | null>;
  outline: Outline;
  editable: boolean;
}) {
  const text = useText(textRef);
  return (
    <>
      <input
        ref={inputRef}
        className={styles.title}
        aria-label="Page title"
        value={typeof text?.value === "string" ? text.value : ""}
        readOnly={!editable}
        onBlur={() => flushText(textRef)}
        onChange={(event) => outline.setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (!editable || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const first = outline.rows[0];
          if (first && isNoteRow(first)) outline.focusRow(first.key);
          else outline.insert("start");
        }}
      />
      <NoteConflict textRef={textRef} />
    </>
  );
}

function RowText({
  textRef,
  rowKey,
  label,
  outline,
  editable,
  inspection = null,
  embeddedItem,
  row,
  selectBlock,
}: {
  textRef: string;
  rowKey: string;
  label: string;
  outline: Outline;
  editable: boolean;
  inspection?: NoteInspection | null;
  embeddedItem?: ResourceItem | null;
  row?: Row;
  selectBlock?: () => void;
}) {
  const text = useText(textRef);
  const focus = outline.focus?.key === rowKey ? outline.focus : null;
  const draft = outline.latent && row !== undefined;
  if (!text || typeof text.value === "string") return null;
  const structural = row && editable && !draft && structuralRow(row);
  const position = row ? outline.position(row) : null;
  const source = outline.insertionSource(row);
  const owner = row?.endpoint ?? outline.endpoint;
  return (
    <>
      <NoteEditor
        editorKey={`${textRef}@${rowKey}`}
        reference={
          editable && (!row || position !== null)
            ? {
                source,
                prelude: outline.referencePrelude(row),
                label: "write a note, or @ link something",
                textRef,
                position,
                positionBasis: outline.node(owner),
                onInserted: (result) =>
                  outline.inserted(result, owner, position),
                onUndoCreated: outline.undoCreated,
                onActiveChange: (active) =>
                  outline.setReferenceActive(rowKey, active),
              }
            : null
        }
        containingNoteRef={text.acked === null ? null : textRef}
        body={text.value}
        revision={text.revision}
        editable={editable}
        label={label}
        compact={row !== undefined}
        inspection={inspection}
        focus={focus}
        history={{
          undo: outline.undo,
          redo: outline.redo,
          boundary: outline.boundary,
        }}
        onEdit={(edit) => outline.editText(rowKey, textRef, edit)}
        embeddedItem={embeddedItem}
        keys={
          row && editable
            ? {
                split: (left: NoteBody, right: NoteBody) => {
                  if (structural || draft) outline.split(row, left, right);
                },
                emptyBackspace: () =>
                  row.link.connection?.mutation?.kind === "unlink" &&
                  outline.remove([row]),
                join: (direction) => structural && outline.join(row, direction),
                indent: (at) => structural && outline.indent(row, at),
                outdent: (at) => structural && outline.outdent(row, at),
                selectBlock: () => selectBlock?.(),
              }
            : null
        }
      />
      <NoteConflict textRef={textRef} />
    </>
  );
}

function OutlineRow({ row, index, outline, editable, canCreate, selectable, focusedBranch, selected, drop, onDragStart, onDragOver, onDragEnd, onDrop, onSelect, warn, childrenRows }: {
  row: Row; index: number; outline: Outline; editable: boolean; canCreate: boolean; selectable: boolean; focusedBranch: string | null; selected: boolean; drop: Placement | null;
  onDragStart(): void; onDragOver(placement: Placement): void; onDragEnd(): void; onDrop(): void;
  onSelect(extend: boolean): void; warn(title: string, message?: string): void; childrenRows: ReactNode;
}) {
  const node = row.link.target;
  const insertion=endpointForResource(node.item.ref);
  const inFocusedBranch = focusedBranch === null || row.key === focusedBranch || row.key.startsWith(`${focusedBranch}/`);
  const text = useText(node.item.ref);
  const note = node.content.kind === "note";
  const terminal = row.terminal !== null;
  const preview=node.item.preview.body;
  const captured=preview.kind === "passage" ? preview.exact.text : preview.kind === "prose" ? preview.excerpt.text : node.item.label;
  const plain = node.content.kind === "note" ? text && typeof text.value!=="string" ? text.value.body_text : node.content.body_text : captured;
  const label = plain.split("\n")[0]!.trim().slice(0, 48) || "note";
  const movable = editable && outline.activeReference===null && !(outline.latent && note);
  return <ResourceOutlineRow connection={row.link.connection ?? undefined} historical={row.link.connection?.origin==="citation" && row.link.connection.snapshot!==null} item={node.item} occurrenceKey={row.key} edgeId={row.link.link_id} onFocusBranch={note && !terminal ? () => outline.zoom(row) : undefined}
    rootProps={{ "data-selected": selected, "data-drop": drop ?? undefined,
      onDragOver: (event) => { if (!editable) return; event.preventDefault(); event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); const at = (event.clientY - box.top) / box.height; onDragOver(at < 0.25 ? "before" : at > 0.75 || !isNoteRow(row) ? "after" : "inside"); },
      onDrop: (event) => { event.preventDefault(); event.stopPropagation(); onDrop(); },
    }}
    bulletProps={{ draggable: movable, onDragStart: (event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.key); onDragStart(); }, onDragEnd }}
    body={note && !terminal ? <div className={styles.editor}><RowText textRef={node.item.ref} rowKey={row.key} label={`Edit note ${index + 1}`} outline={outline} editable={editable && (outline.activeReference===null || outline.activeReference===row.key)} embeddedItem={node.content.kind === "note" ? node.content.embedded_item : null} row={row} selectBlock={() => onSelect(false)} /></div> : undefined}
    placement={{ expanded: row.open, toggle: () => outline.toggle(row), children: <>
      <BranchStatus outline={outline} resourceRef={node.item.ref} />
       {childrenRows}
       {canCreate && inFocusedBranch && row.link.connection?.origin!=="citation" && outline.persisted(node.item.ref) && insertion ? <ResourceComposer source={insertion} occurrenceKey={`notes:${row.key}`} label="add item" onActiveChange={(active)=>outline.setReferenceActive(`${row.key}/composer`,active)} /> : null}
    </> }}
    actions={<>{editable ? <InsertNoteButton outline={outline} at={{afterRowKey:row.key}} label={plain.trim() ? `add note after “${label}”` : "add note after this item"} tooltip="add note after this item" /> : null}<RowMenu row={row} label={label} text={plain} outline={outline} movable={movable} canAdd={canCreate} onAdd={() => { if (!row.open) outline.toggle(row); }} onSelect={selectable ? () => onSelect(false) : undefined} warn={warn} /></>}
  />;
}

function BranchStatus({
  outline,
  resourceRef,
}: {
  outline: Outline;
  resourceRef: string;
}) {
  const read = useResourceOutline(
    outline.persisted(resourceRef) ? resourceRef : null,
  );
  const adopt = outline.adoptBranch;
  useEffect(() => {
    if (read.status === "ready" && read.source && read.version !== null)
      adopt(read.source, read.items, read.version, read.complete);
  }, [
    read.status,
    read.source,
    read.items,
    read.version,
    read.complete,
    adopt,
  ]);
  return (
    <>
      {outline.persisted(resourceRef) && read.status === "loading" ? (
        <p role="status">loading linked resources…</p>
      ) : null}
      {read.error ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "couldn’t load linked resources",
            requestId: read.error.requestId,
          }}
          announcement="Assertive"
          actions={[{ label: "retry", onClick: read.retry }]}
        />
      ) : null}
      {!read.complete && read.status === "ready" ? (
        <button type="button" onClick={read.more}>
          show more
        </button>
      ) : null}
    </>
  );
}

/** The row's resource actions (fetched on open) and the outline's own verbs; a verb that
 * cannot run here is absent (never shown disabled without a reason). */
function RowMenu({
  row,
  label,
  text,
  outline,
  movable,
  onSelect,
  onAdd,
  canAdd,
  warn,
}: {
  row: Row;
  label: string;
  text: string;
  outline: Outline;
  movable: boolean;
  onSelect?: () => void;
  onAdd: () => void;
  canAdd: boolean;
  warn: (title: string, message?: string) => void;
}) {
  const resource = useResourceActionMenu(row.link.target.item.ref);
  const resourceOutline = useContext(ResourceOutlineContext);
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  const copy = (work: Promise<void>) =>
    void work.catch((error: unknown) => {
      if (!(error instanceof ClipboardWriteUnavailableError)) throw error;
      warn("Copy unavailable", "Clipboard access is unavailable.");
    });
  const href = row.link.target.item.activation.href;
  const links = siblingsOf(outline.rows, row);
  const position = links.indexOf(row);
  const structural = movable && structuralRow(row);
  const note = structural && isNoteRow(row);
  const verb = (id: string, label: string, run: () => void): ActionDescriptor => ({
    kind: "command",
    id: `Notes.${id}`,
    label,
    tone: id === "RemoveLink" ? "danger" : undefined,
    onSelect: run,
  });
  const link = (url: string) => new URL(url, window.location.origin).href;
  const verbs = [
    ...resource.options.filter((action) => action.tone !== "danger"),
    canAdd && outline.persisted(row.link.target.item.ref) && endpointForResource(row.link.target.item.ref)!==null && row.link.connection?.origin!=="citation" && verb("AddItem", "add item", onAdd),
    row.terminal === null && verb("FocusBranch", "Focus this branch", () => {
      if (isNoteRow(row)) outline.zoom(row);
      else {
        if (!row.open) outline.toggle(row);
        resourceOutline?.focus(row.key);
      }
    }),
    onSelect && verb("SelectBlock", "Select block", onSelect),
    row.terminal === null && verb("CopyText", "Copy text", () => copy(copyText(text))),
    href !== null &&
      verb("CopyLink", "Copy link", () => copy(copyResourceLink(link(href), row.link.target.item.ref))),
    note && indentParent(outline.rows, row) && verb("IndentLink", "Indent link", () => outline.indent(row)),
    note && row.path.length > 1 && verb("OutdentLink", "Outdent link", () => outline.outdent(row)),
    movable && position > 0 && verb("MoveEarlier", "Move link earlier", () => outline.move(row, -1)),
    movable && position < links.length - 1 && verb("MoveLater", "Move link later", () => outline.move(row, 1)),
    onSelect && row.link.connection?.mutation?.kind === "unlink" && verb("RemoveLink", "remove link from both items; keep their notes", () => outline.remove([row])),
    ...resource.options.filter((action) => action.tone === "danger"),
  ];
  return (
    <ActionMenu
      label={`More actions for ${label}`}
      options={verbs.filter((option): option is ActionDescriptor => !!option).map((action)=>outline.activeReference!==null && action.kind === "command" ? {...action,disabled:true,disabledReason:"finish linking or return to prose first"} : action)}
      onOpenChange={(next) => {
        setOpen(next);
        resource.onOpenChange(next);
      }}
    />
  );
}
