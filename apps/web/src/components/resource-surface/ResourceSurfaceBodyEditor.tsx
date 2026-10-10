"use client";

import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronRight, Link2, Plus } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import NoteBodyEditor, { type NoteBodyEdit, type NoteBodyEditorDocument, type NoteBodyInputHandoff, type NoteBodySelection } from "@/components/notes/NoteBodyEditor";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import type { ResourceItem, SurfacePosition } from "@/lib/resources/resourceItems";
import type { ResourceOutline, OutlineRow } from "@/lib/resourceSurface/outline";
import { ProtectedSurfaceLinkError, TerminalSurfaceLinkError } from "@/lib/resourceSurface/outline";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { resourceSurfaceFilterFields } from "./resourceSurfaceFilterFields";
import styles from "./ResourceSurfaceBodyEditor.module.css";

interface Props {
  editorSessionKey: string;
  outline: ResourceOutline;
  rowFilterQuery?: string;
  editable?: boolean;
  structuralEditing?: boolean;
  focusRequest?: { occurrenceId: string | null; serial: number };
  bodyDocument: (id: string) => NoteBodyEditorDocument;
  restoreSelection: (id: string) => { token: number; selection: NoteBodySelection } | undefined;
  onBodyEdit: (input: { occurrenceId: string; edit: NoteBodyEdit }) => void;
  onSelectionChange: (input: { occurrenceId: string; selection: NoteBodySelection }) => void;
  onHistoryBoundary: (id: string) => void;
  onUndo: (id: string) => void;
  onRedo: (id: string) => void;
  onFlush: () => void;
  onActivate: (item: ResourceItem, disposition: WorkspaceTargetDisposition) => void;
  onOpenObject: (objectType: string, objectId: string, disposition: WorkspaceTargetDisposition) => void;
  onFeedback: (feedback: FeedbackContent) => void;
  onError?: (error: unknown) => void;
  inputHandoff?: { noteRef: string; handoff: NoteBodyInputHandoff } | null;
  onInputHandoffClaimed?: (id: string) => void;
}

export default function ResourceSurfaceBodyEditor({
  editorSessionKey, outline, rowFilterQuery = "", editable = true,
  structuralEditing = true, focusRequest, bodyDocument, restoreSelection,
  onBodyEdit, onSelectionChange, onHistoryBoundary, onUndo, onRedo, onFlush,
  onActivate, onOpenObject, onFeedback, onError, inputHandoff,
  onInputHandoffClaimed,
}: Props) {
  const { linkComposer } = useResourceOverlaysController();
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; placement: "before" | "after" | "inside" } | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const filtering = rowFilterQuery.trim().length > 0;
  const structural = editable && structuralEditing && !filtering;
  const visibleRows = useMemo(() => filtering
    ? outline.rows.filter((row) => matchesPaneFilterQuery(rowFilterQuery, resourceSurfaceFilterFields(row)))
    : outline.rows, [filtering, outline.rows, rowFilterQuery]);
  const selected = outline.selection?.kind === "blocks" ? outline.selection.occurrenceIds : [];
  const selectedSet = new Set(selected);
  const lastTopRow = outline.rows.filter((row) => row.depth === 0).at(-1);
  const end: SurfacePosition = lastTopRow ? { kind: "after", linkId: lastTopRow.linkId } : { kind: "start" };
  const report = (failure: unknown) => {
    if (failure instanceof ProtectedSurfaceLinkError) {
      onFeedback({ tone: "Warning", title: "This link has a note", message: "Use link actions to change it." });
    } else if (failure instanceof TerminalSurfaceLinkError) {
      onFeedback({ tone: "Warning", title: "Already shown above", message: "Edit the earlier appearance." });
    } else if (failure instanceof ClipboardWriteUnavailableError) {
      onFeedback({ tone: "Warning", title: "Copy unavailable", message: "Clipboard access is unavailable." });
    } else onError?.(failure);
  };
  const run = (operation: Promise<void> | void) => { if (operation) void operation.catch(report); };
  const focusSerial = (id: string) => focusRequest?.occurrenceId === id ? focusRequest.serial : outline.focusRequest?.occurrenceId === id ? outline.focusRequest.serial : 0;
  const selectBlock = (id: string, extend = false) => {
    outline.select(id, extend);
    window.getSelection()?.removeAllRanges();
    sectionRef.current?.focus();
  };
  const blockKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== sectionRef.current) return;
    const key = event.key;
    const mac = navigator.platform.toLowerCase().includes("mac");
    const modifier = mac ? event.metaKey : event.ctrlKey;
    if (modifier && key.toLowerCase() === "z" || !mac && event.ctrlKey && key.toLowerCase() === "y") {
      event.preventDefault();
      if (event.shiftKey || key.toLowerCase() === "y") onRedo(""); else onUndo("");
      return;
    }
    if (outline.selection?.kind !== "blocks" || !selected.length) return;
    const current = selected.length === 1 || selected[0] === outline.selection.anchor
      ? selected.at(-1)!
      : selected[0]!;
    const index = visibleRows.findIndex((row) => row.occurrenceId === current);
    const provisional = current.startsWith("daily-provisional:");
    const reorder = mac ? event.metaKey : event.altKey;
    if (key === "Tab") {
      event.preventDefault();
      const focusables = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => !sectionRef.current?.contains(element) && element.getClientRects().length > 0);
      const outside = event.shiftKey
        ? focusables.filter((element) => Boolean((sectionRef.current?.compareDocumentPosition(element) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING)).at(-1)
        : focusables.find((element) => Boolean((sectionRef.current?.compareDocumentPosition(element) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING));
      outside?.focus();
      return;
    }
    if (key === "Escape") { event.preventDefault(); outline.clearSelection(); return; }
    if (key === "Enter") {
      event.preventDefault();
      const row = visibleRows[index];
      if (row?.terminal) run(outline.focus(row.occurrenceId));
      else if (row?.target.content.kind === "note_body") outline.resume(row.occurrenceId);
      else if (row) onActivate(row.target.item, { kind: "Follow" });
      return;
    }
    if (!structural || provisional) return;
    if (modifier && !event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      event.preventDefault(); run(outline.fold(current, key === "ArrowUp")); return;
    }
    if (reorder && event.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      event.preventDefault(); if (selected.length === 1) run(outline.move(current, key === "ArrowUp" ? "up" : "down")); return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      const next = visibleRows[index + (key === "ArrowUp" ? -1 : 1)];
      if (next) outline.select(next.occurrenceId, event.shiftKey);
      return;
    }
    if (key === "Backspace" || key === "Delete") { event.preventDefault(); run(outline.remove(selected)); }
  };
  return (
    <section ref={sectionRef} className={styles.body} aria-label="Linked notes" data-pane-return-scope="Notes.EditorBlocks" tabIndex={-1}
      onKeyDown={blockKey}
      onCopy={(event) => { if (selected.length) { event.preventDefault(); run(outline.copy(event.clipboardData)); } }}
      onCut={(event) => { if (structural && selected.length && selected.every((id) => !id.startsWith("daily-provisional:"))) { event.preventDefault(); run(outline.copy(event.clipboardData, true)); } }}
      onPaste={(event) => { if (structural && selected.length && selected.every((id) => !id.startsWith("daily-provisional:"))) { event.preventDefault(); void outline.paste(event.clipboardData).catch(report); } }}>
      {outline.focusedPath ? <Button variant="ghost" size="sm" onClick={outline.returnFocus}>Back to linked notes</Button> : null}
      {filtering ? <p className={styles.inspectionNotice} role="status">Filtered view is inspection only — clear Filter to edit.</p> : null}
      <ol className={styles.rows}>
        {visibleRows.map((row, index) => {
          const item = row.target.item;
          const isNote = row.target.content.kind === "note_body";
          const terminal = row.terminal !== null;
          const noteText = row.target.content.kind === "note_body"
            ? terminal ? row.target.content.bodyText : bodyDocument(row.occurrenceId).body.bodyText
            : null;
          const label = noteText !== null
            ? noteText.split("\n")[0]?.trim().slice(0, 48) || "note"
            : item.label.trim() || "linked item";
          const provisional = row.linkId.startsWith("daily-provisional:");
          const canEditLink = structural && !terminal && !provisional && selected.length <= 1;
          const marked = selectedSet.has(row.occurrenceId);
          const style = { "--outline-depth": row.depth } as CSSProperties;
          return <li key={row.occurrenceId} className={isNote ? styles.noteRow : styles.resourceRow} style={style}
            data-occurrence-id={row.occurrenceId} data-collection-row-id={row.occurrenceId} data-note-ref={isNote ? item.ref : undefined}
            data-selected={marked || undefined} data-drop={drop?.id === row.occurrenceId ? drop.placement : undefined}
            onDragOver={(event) => {
              if (!dragId || dragId === row.occurrenceId || !structural) return;
              event.preventDefault();
              const fraction = (event.clientY - event.currentTarget.getBoundingClientRect().top) / event.currentTarget.getBoundingClientRect().height;
              const inside = isNote && !terminal && !provisional;
              setDrop({ id: row.occurrenceId, placement: fraction < 0.25 ? "before" : fraction > 0.75 || !inside ? "after" : "inside" });
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(event) => { event.preventDefault(); if (dragId && drop) run(outline.drop(dragId, drop.id, drop.placement)); setDragId(null); setDrop(null); }}>
            <div className={styles.rowLead}>
              <button type="button" className={styles.bullet} aria-label={isNote ? `Focus linked notes for ${label}` : `Open ${label}`}
                draggable={canEditLink}
                onDragStart={(event) => { setDragId(row.occurrenceId); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", row.occurrenceId); }}
                onDragEnd={() => { setDragId(null); setDrop(null); }}
                onClick={(event) => event.shiftKey ? selectBlock(row.occurrenceId, true) : isNote ? run(outline.focus(row.occurrenceId)) : onActivate(item, workspaceTargetClickIntent(event).disposition)}>•</button>
              {isNote && !terminal && !provisional ? <button type="button" className={styles.disclosure}
                aria-label={`${row.collapsed || row.neighborhood !== "ready" ? "Show" : "Hide"} linked notes for ${label}`} aria-expanded={!row.collapsed && row.neighborhood === "ready"}
                onClick={() => run(outline.fold(row.occurrenceId, row.neighborhood === "ready" && !row.collapsed))}>
                <ChevronRight size={14} aria-hidden="true" data-open={!row.collapsed && row.neighborhood === "ready" || undefined} />
              </button> : null}
            </div>
            {terminal ? <button type="button" className={styles.terminal} aria-label={`Return to ${label}, already shown above`} onClick={() => run(outline.focus(row.occurrenceId))}>Already shown above: {label}</button>
              : isNote ? <div className={styles.noteEditor}><NoteBodyEditor
                resourceKey={`${editorSessionKey}:${row.occurrenceId}:${item.ref}`}
                document={bodyDocument(row.occurrenceId)} restoreSelection={restoreSelection(row.occurrenceId)}
                editable={editable && !filtering} ariaLabel={`Edit note ${index + 1}`} focusRequest={focusSerial(row.occurrenceId)}
                onEdit={(edit) => onBodyEdit({ occurrenceId: row.occurrenceId, edit })}
                onSelectionChange={(selection) => onSelectionChange({ occurrenceId: row.occurrenceId, selection })}
                onHistoryBoundary={() => onHistoryBoundary(row.occurrenceId)}
                onUndoRequest={() => onUndo(row.occurrenceId)} onRedoRequest={() => onRedo(row.occurrenceId)} onFlushRequest={onFlush}
                onSplit={canEditLink ? (split) => run(outline.split(row.occurrenceId, split)) : undefined}
                onEmptyBackspace={canEditLink ? () => run(outline.remove([row.occurrenceId])) : undefined}
                onIndent={canEditLink ? () => run(outline.indent(row.occurrenceId)) : undefined}
                onOutdent={canEditLink ? () => run(outline.outdent(row.occurrenceId)) : undefined}
                onBoundaryJoin={canEditLink ? (direction) => run(outline.join(row.occurrenceId, direction)) : undefined}
                onSelectBlock={() => selectBlock(row.occurrenceId)}
                onOpenObject={onOpenObject} onFeedback={onFeedback} onError={onError}
                inputHandoff={inputHandoff?.noteRef === item.ref ? inputHandoff.handoff : null}
                onInputHandoffClaimed={onInputHandoffClaimed}
              /></div>
              : <button type="button" className={styles.resourceActivation} aria-label={`Open ${label}`}
                onClick={(event) => onActivate(item, workspaceTargetClickIntent(event).disposition)}>
                  <span className={styles.resourceLabel}>{label}</span>
                  {item.summary ? <span className={styles.resourceSummary}>{item.summary}</span> : null}
                </button>}
            {row.neighborhood === "loading" && !row.collapsed ? <span className={styles.neighborhoodStatus} role="status">Loading linked notes…</span> : null}
            {row.neighborhood === "error" && !row.collapsed ? <span className={styles.neighborhoodStatus} role="status">Linked notes unavailable. Try Show linked notes again.</span> : null}
            <div className={styles.rowActions}><RowActions row={row} label={label} text={noteText ?? label} outline={outline} enabled={canEditLink} report={report} onSelectBlock={() => selectBlock(row.occurrenceId)} /></div>
          </li>;
        })}
        {filtering && !visibleRows.length ? <li className={styles.emptyRow} role="status">No items match this filter.</li> : null}
        {structural ? <li className={styles.insertionRow}><button type="button" className={styles.insertNote} onClick={() => outline.insert(end)}><Plus size={16} aria-hidden="true" />Add a note</button></li> : null}
      </ol>
      {structural ? <div className={styles.addItem}><Button variant="ghost" size="sm" leadingIcon={<Link2 size={16} aria-hidden="true" />} onClick={() => void linkComposer.openResourceLink(outline.activeEndpointRef)}>Link…</Button></div> : null}
    </section>
  );
}

function RowActions({ row, label, text, outline, enabled, report, onSelectBlock }: {
  row: OutlineRow; label: string; text: string; outline: ResourceOutline; enabled: boolean;
  report: (error: unknown) => void; onSelectBlock: () => void;
}) {
  const model = useResourceActionMenuModel({ ref: assumeCanonicalResourceRef(row.target.item.ref) });
  const [menuOpen, setMenuOpen] = useState(false);
  useMobileChromeHold(menuOpen);
  const refresh = model.refresh;
  const onOpenChange = useCallback((open: boolean) => {
    setMenuOpen(open);
    if (open) refresh();
  }, [refresh]);
  const run = (work: Promise<void>) => { void work.catch(report); };
  const siblings = outline.rows.filter((candidate) => candidate.endpointRef === row.endpointRef && candidate.path.linkPath.slice(0, -1).join() === row.path.linkPath.slice(0, -1).join());
  const index = siblings.findIndex((candidate) => candidate.occurrenceId === row.occurrenceId);
  const preceding = siblings.slice(0, index).reverse().find((candidate) => !candidate.terminal && candidate.target.content.kind === "note_body");
  const options: ActionDescriptor[] = [...model.descriptors.filter((action) => action.tone !== "danger")];
  options.push(
    { kind: "command", id: "Notes.SelectBlock", label: "Select block", onSelect: onSelectBlock },
    { kind: "command", id: "Notes.CopyText", label: "Copy text", disabled: Boolean(row.terminal), onSelect: () => run(copyText(text)) },
    { kind: "command", id: "Notes.CopyLink", label: "Copy link", disabled: !row.target.item.activation.href, onSelect: () => run(outline.copyLink(row.occurrenceId)) },
    { kind: "command", id: "Notes.IndentLink", label: "Indent link", disabled: !enabled || row.target.content.kind !== "note_body" || row.hasLinkNote || !preceding || preceding.target.item.ref === row.target.item.ref, onSelect: () => run(outline.indent(row.occurrenceId)) },
    { kind: "command", id: "Notes.OutdentLink", label: "Outdent link", disabled: !enabled || row.target.content.kind !== "note_body" || row.hasLinkNote || row.path.linkPath.length < 2, onSelect: () => run(outline.outdent(row.occurrenceId)) },
    { kind: "command", id: "Notes.MoveEarlier", label: "Move link earlier", disabled: !enabled || index <= 0, onSelect: () => run(outline.move(row.occurrenceId, "up")) },
    { kind: "command", id: "Notes.MoveLater", label: "Move link later", disabled: !enabled || index >= siblings.length - 1, onSelect: () => run(outline.move(row.occurrenceId, "down")) },
    { kind: "command", id: "Notes.RemoveLink", label: "Remove link", tone: "danger", disabled: !enabled || row.hasLinkNote, onSelect: () => run(outline.remove([row.occurrenceId])) },
  );
  options.push(...model.descriptors.filter((action) => action.tone === "danger"));
  return <ActionMenu label={`More actions for ${label}`} options={options} onOpenChange={onOpenChange} />;
}
