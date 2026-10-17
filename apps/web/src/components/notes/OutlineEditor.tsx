"use client";

// An outline pane's editing surface: the masthead (the page title, or the root note),
// its rows (note editors, resource cards, "Already shown above" returns), block
// selection, drag, the row menu, "Add a note" and "Link…". A pane filter makes it a
// read-only inspection of the loaded rows.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ChevronRight, Link2, Plus } from "lucide-react";
import { useFeedback } from "@/components/feedback/Feedback";
import NoteEditor, { type NotePulse } from "@/components/notes/NoteEditor";
import { NoteConflict, WritingStatus } from "@/components/notes/NoteNotices";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import type { NoteBody } from "@/lib/notes/noteBody";
import { indentParent, isNoteRow, siblingsOf, type Row } from "@/lib/notes/outline";
import { flushText, useText } from "@/lib/notes/texts";
import type { Outline } from "@/lib/notes/useOutline";
import type { PaneQuery } from "@/lib/panes/paneChrome";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { activateResource } from "@/lib/resources/activation";
import { resolveResourceItem } from "@/lib/resources/items";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
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
  return [node.label.trim() || node.ref.split(":")[0]!.replaceAll("_", " "), node.summary];
};

/** The pane filter over an outline's loaded rows (counts are complete once loaded). */
export function useOutlineFilter(outline: Outline, sourceKey: string, inputLabel: string) {
  const fields = JSON.stringify(outline.rows.map(rowFields));
  const ready = outline.status === "ready";
  const getRowStatus = useCallback(
    (query: string) => {
      const rows: string[][] = JSON.parse(fields);
      const visibleCount = rows.filter((row) => matchesPaneFilterQuery(query, row)).length;
      const unit = { singular: "item", plural: "items" };
      const count = rows.length;
      return ready
        ? ({ kind: "Complete", visibleCount, totalCount: count, unit } as const)
        : ({ kind: "Partial", visibleCount, loadedCount: count, unit } as const);
    },
    [fields, ready],
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
          status={{ placement: "Details", id: statusId, content: <PaneFilterRowsStatus id={statusId} status={rowStatus} query={query} /> }}
          onReset={query ? clearQuery : undefined}
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
  pulse,
  titleRef,
  activateTarget,
}: {
  outline: Outline;
  filter: string;
  pulse: NotePulse | null;
  titleRef: RefObject<HTMLInputElement | null>;
  activateTarget: Activate;
}) {
  const source = outline.root!.source;
  const filtering = filter.trim() !== "";
  const editable = !filtering;
  const feedback = useFeedback();
  const linkComposer = useLinkComposerHost();
  const section = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: string | null; placement: Placement } | null>(null);
  const selected = outline.selection?.kind === "blocks" ? outline.selection.keys : [];
  const rows = useMemo(
    () => (filtering ? outline.rows.filter((row) => matchesPaneFilterQuery(filter, rowFields(row))) : outline.rows),
    [filter, filtering, outline.rows],
  );
  const warn = useCallback(
    (title: string, message?: string) => feedback.publish({ kind: "Hud", content: { tone: "Warning", title, message } }),
    [feedback],
  );
  const activate = (row: Row, disposition: WorkspaceTargetDisposition) =>
    activateResource(row.link.target.activation, { labelHint: row.link.target.label, disposition, activateTarget });
  const openEmbed = useCallback(
    (ref: string, disposition: WorkspaceTargetDisposition) =>
      void resolveResourceItem(ref).then(
        (item) => {
          if (!activateResource(item.activation, { disposition, activateTarget }))
            warn("Linked object couldn’t be opened");
        },
        (error: unknown) => {
          if (!handleUnauthenticatedApiError(error)) warn("Linked object couldn’t be opened");
        },
      ),
    [activateTarget, warn],
  );

  // A return to the root focuses the masthead; the root note's editor takes it itself.
  const focus = outline.focus;
  useEffect(() => {
    if (focus?.key !== "" || source.content.kind !== "page") return;
    titleRef.current?.focus();
  }, [focus, source.content.kind, titleRef]);

  const selectBlock = (key: string, extend = false) => {
    outline.select(key, extend);
    window.getSelection()?.removeAllRanges();
    section.current?.focus();
  };

  const onBlockKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== section.current) return;
    const key = event.key;
    const mac = navigator.platform.toLowerCase().includes("mac");
    const mod = mac ? event.metaKey : event.ctrlKey;
    const handled = () => event.preventDefault();
    if ((mod && key.toLowerCase() === "z") || (!mac && event.ctrlKey && key.toLowerCase() === "y")) {
      handled();
      return event.shiftKey || key.toLowerCase() === "y" ? outline.redo() : outline.undo();
    }
    if (!selected.length) return;
    const current = selected.length === 1 || selected[0] === outline.selection?.anchor ? selected.at(-1) : selected[0];
    const index = rows.findIndex((row) => row.key === current);
    const row = rows[index];
    if (!row) return;
    if (key === "Tab") return void (handled(), leave(section.current!, event.shiftKey));
    if (key === "Escape") return void (handled(), outline.clearSelection());
    if (key === "Enter") {
      handled();
      if (row.terminal !== null) return outline.zoom(row);
      return isNoteRow(row) ? outline.focusRow(row.key) : void activate(row, { kind: "Follow" });
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
        if (event.target !== section.current || !selected.length) return;
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
          <Title textRef={source.ref} inputRef={titleRef} outline={outline} editable={editable} />
        ) : (
          <RowText
            textRef={source.ref}
            rowKey=""
            label="Note content"
            outline={outline}
            editable={editable}
            pulse={pulse}
            openEmbed={openEmbed}
          />
        )}
        <WritingStatus />
      </div>
      {outline.zoomed ? (
        <Button variant="ghost" size="sm" onClick={outline.zoomOut}>
          Back to linked notes
        </Button>
      ) : null}
      {filtering ? (
        <p className={styles.notice} role="status">
          Filtered view is inspection only — clear Filter to edit.
        </p>
      ) : null}
      <ol className={styles.rows}>
        {rows.map((row, index) => (
          <OutlineRow
            key={row.key}
            row={row}
            index={index}
            outline={outline}
            editable={editable}
            selected={selected.includes(row.key)}
            drop={drag?.over === row.key ? drag.placement : null}
            onDragStart={() => setDrag({ key: row.key, over: null, placement: "after" })}
            onDragOver={(placement) => drag && drag.key !== row.key && setDrag({ ...drag, over: row.key, placement })}
            onDragEnd={() => setDrag(null)}
            onDrop={() => {
              const from = outline.rows.find((r) => r.key === drag?.key);
              if (from && drag?.over === row.key) outline.drop(from, row, drag.placement);
              setDrag(null);
            }}
            onSelect={(extend) => selectBlock(row.key, extend)}
            activate={(disposition) => activate(row, disposition)}
            openEmbed={openEmbed}
            warn={warn}
          />
        ))}
        {filtering && !rows.length ? (
          <li className={styles.empty} role="status">
            No items match this filter.
          </li>
        ) : null}
        {editable ? (
          <li className={styles.insertion}>
            <button type="button" className={styles.insert} onClick={() => outline.insert("end")}>
              <Plus size={16} aria-hidden="true" />
              Add a note
            </button>
          </li>
        ) : null}
      </ol>
      {editable && !outline.latent ? (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Link2 size={16} aria-hidden="true" />}
          onClick={() => void linkComposer.openResourceLink(outline.endpoint)}
        >
          Link…
        </Button>
      ) : null}
    </section>
  );
}

/** Block selection's Tab leaves the outline for the next (or previous) focusable. */
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
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
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
  pulse = null,
  openEmbed,
  row,
  selectBlock,
}: {
  textRef: string;
  rowKey: string;
  label: string;
  outline: Outline;
  editable: boolean;
  pulse?: NotePulse | null;
  openEmbed: (ref: string, disposition: WorkspaceTargetDisposition) => void;
  row?: Row;
  selectBlock?: () => void;
}) {
  const text = useText(textRef);
  const focus = outline.focus?.key === rowKey ? outline.focus : null;
  const draft = outline.latent && row !== undefined;
  if (!text || typeof text.value === "string") return null;
  const structural = row && editable && !draft && row.terminal === null;
  return (
    <>
      <NoteEditor
        editorKey={`${textRef}@${rowKey}`}
        body={text.value}
        revision={text.revision}
        editable={editable}
        label={label}
        pulse={pulse}
        focus={focus}
        history={{ undo: outline.undo, redo: outline.redo, boundary: outline.boundary }}
        onEdit={(edit) => outline.editText(rowKey, textRef, edit)}
        onOpenEmbed={openEmbed}
        keys={
          row && editable
            ? {
                split: (left: NoteBody, right: NoteBody) => outline.split(row, left, right),
                emptyBackspace: () => structural && outline.remove([row]),
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

function OutlineRow({
  row,
  index,
  outline,
  editable,
  selected,
  drop,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  onSelect,
  activate,
  openEmbed,
  warn,
}: {
  row: Row;
  index: number;
  outline: Outline;
  editable: boolean;
  selected: boolean;
  drop: Placement | null;
  onDragStart: () => void;
  onDragOver: (placement: Placement) => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onSelect: (extend: boolean) => void;
  activate: (disposition: WorkspaceTargetDisposition) => void;
  openEmbed: (ref: string, disposition: WorkspaceTargetDisposition) => void;
  warn: (title: string, message?: string) => void;
}) {
  const node = row.link.target;
  const text = useText(node.ref);
  const note = node.content.kind === "note";
  const terminal = row.terminal !== null;
  const plain = note
    ? terminal || !text || typeof text.value === "string"
      ? node.content.kind === "note" ? node.content.body_text : ""
      : text.value.body_text
    : null;
  const label =
    plain !== null
      ? plain.split("\n")[0]!.trim().slice(0, 48) || "note"
      : node.label.trim() || "linked item";
  const movable = editable && !terminal && !(outline.latent && note);
  return (
    <li
      className={note ? styles.noteRow : styles.resourceRow}
      style={{ "--outline-depth": row.depth } as CSSProperties}
      data-occurrence-id={row.key}
      data-collection-row-id={row.key}
      data-note-ref={note ? node.ref : undefined}
      data-selected={selected || undefined}
      data-drop={drop ?? undefined}
      onDragOver={(event) => {
        if (!editable) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const at = (event.clientY - box.top) / box.height;
        onDragOver(at < 0.25 ? "before" : at > 0.75 || !isNoteRow(row) ? "after" : "inside");
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <div className={styles.lead}>
        <button
          type="button"
          className={styles.bullet}
          aria-label={note ? `Focus linked notes for ${label}` : `Open ${label}`}
          draggable={movable}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", row.key);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          onClick={(event) => {
            if (event.shiftKey) return onSelect(true);
            if (note) return outline.zoom(row);
            activate(workspaceTargetClickIntent(event).disposition);
          }}
        >
          •
        </button>
        {isNoteRow(row) ? (
          <button
            type="button"
            className={styles.disclosure}
            aria-label={`${row.open ? "Hide" : "Show"} linked notes for ${label}`}
            aria-expanded={row.open}
            onClick={() => outline.toggle(row)}
          >
            <ChevronRight size={14} aria-hidden="true" data-open={row.open || undefined} />
          </button>
        ) : null}
      </div>
      {terminal ? (
        <button
          type="button"
          className={styles.terminal}
          aria-label={`Return to ${label}, already shown above`}
          onClick={() => outline.zoom(row)}
        >
          Already shown above: {label}
        </button>
      ) : note ? (
        <div className={styles.editor}>
          <RowText
            textRef={node.ref}
            rowKey={row.key}
            label={`Edit note ${index + 1}`}
            outline={outline}
            editable={editable}
            openEmbed={openEmbed}
            row={row}
            selectBlock={() => onSelect(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={styles.card}
          aria-label={`Open ${label}`}
          onClick={(event) => activate(workspaceTargetClickIntent(event).disposition)}
        >
          <span className={styles.cardLabel}>{label}</span>
          {node.summary ? <span className={styles.cardSummary}>{node.summary}</span> : null}
        </button>
      )}
      {isNoteRow(row) && outline.loading.has(node.ref) ? (
        <span className={styles.status} role="status">
          Loading linked notes…
        </span>
      ) : null}
      <div className={styles.actions}>
        <RowMenu
          row={row}
          label={label}
          text={plain ?? label}
          outline={outline}
          movable={movable}
          onSelect={() => onSelect(false)}
          warn={warn}
        />
      </div>
    </li>
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
  warn,
}: {
  row: Row;
  label: string;
  text: string;
  outline: Outline;
  movable: boolean;
  onSelect: () => void;
  warn: (title: string, message?: string) => void;
}) {
  const resource = useResourceActionMenu(row.link.target.ref);
  const [open, setOpen] = useState(false);
  useMobileChromeHold(open);
  const copy = (work: Promise<void>) =>
    void work.catch((error: unknown) => {
      if (!(error instanceof ClipboardWriteUnavailableError)) throw error;
      warn("Copy unavailable", "Clipboard access is unavailable.");
    });
  const href = row.link.target.activation.href;
  const links = siblingsOf(outline.rows, row);
  const position = links.indexOf(row);
  const structural = movable && !row.link.has_link_note;
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
    verb("SelectBlock", "Select block", onSelect),
    row.terminal === null && verb("CopyText", "Copy text", () => copy(copyText(text))),
    href !== null &&
      verb("CopyLink", "Copy link", () => copy(copyResourceLink(link(href), row.link.target.ref))),
    note && indentParent(outline.rows, row) && verb("IndentLink", "Indent link", () => outline.indent(row)),
    note && row.path.length > 1 && verb("OutdentLink", "Outdent link", () => outline.outdent(row)),
    movable && position > 0 && verb("MoveEarlier", "Move link earlier", () => outline.move(row, -1)),
    movable && position < links.length - 1 && verb("MoveLater", "Move link later", () => outline.move(row, 1)),
    structural && verb("RemoveLink", "Remove link", () => outline.remove([row])),
    ...resource.options.filter((action) => action.tone === "danger"),
  ];
  return (
    <ActionMenu
      label={`More actions for ${label}`}
      options={verbs.filter((option): option is ActionDescriptor => !!option)}
      onOpenChange={(next) => {
        setOpen(next);
        resource.onOpenChange(next);
      }}
    />
  );
}
