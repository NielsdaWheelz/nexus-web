"use client";

// Occurrence selection and keyboard commands delegate to the session. Nested
// surfaces share its command owner and the outer outline's horizontal scrollport.
import {useLayoutEffect, useRef, type KeyboardEvent} from "react";
import {FeedbackStatus, useFeedback} from "@/components/feedback/Feedback";
import ResourceOutlineList, {OutlineSessionContext} from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import OutlineInsertionLine from "./OutlineInsertionLine";
import {outlineFilterFields} from "./outlineFilterFields";
import {UnavailableTexts} from "./NoteNotices";
import {hasUnsavedText, useText} from "@/lib/notes/texts";
import {readClipboard, structuralRow, type Row} from "@/lib/notes/outline";
import {insertionSourceRef, type DailyPublication, type OutlineDestination, type OutlineSession} from "@/lib/notes/useOutlineSession";
import {endpointForResource, type InsertionSource} from "@/lib/resourceGraph/links";
import {matchesPaneFilterQuery} from "@/lib/panes/paneFilterRows";
import {useRenderEnvironment} from "@/lib/renderEnvironment/provider";
import {resolveResourceItem} from "@/lib/resources/items";
import {isApiError} from "@/lib/api/client";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {outlineStructuralCommand, usesMeta} from "@/lib/shortcuts";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import styles from "./OutlineEditor.module.css";
export interface OutlineSurfaceProps {
  session: OutlineSession; rows: readonly Row[]; endpoint: string; rootEndpoint: string;
  occurrencePrefix: string; path: readonly string[]; filter?: string; editable?: boolean;
  historicalBranch?: boolean; sourceForRow?: (row: Row) => InsertionSource | null;
  publication?: DailyPublication; onRevealRoot?: () => void;
  insertionSource?: InsertionSource | null;
}
/** Clipboard access is synchronous; resource resolution cannot change the captured slot. */
export async function pasteOutline({
  session,
  destination,
  clipboard,
  publication,
}: {
  session: OutlineSession;
  destination: OutlineDestination;
  clipboard: DataTransfer;
  publication?: DailyPublication;
}): Promise<boolean> {
  const items = readClipboard(clipboard);
  if (items === null) return false;
  const refs = [
    ...new Set(
      items.flatMap((item) => (item.kind === "resource" ? [item.ref] : [])),
    ),
  ];
  const resources = Promise.all(refs.map((ref) => resolveResourceItem(ref)));
  return session.paste({
    destination,
    items,
    resources,
    publication,
  });
}

export default function OutlineSurface({session, rows, endpoint, rootEndpoint, occurrencePrefix, path,
  filter = "", editable = true, historicalBranch = false, sourceForRow, publication, onRevealRoot,
  insertionSource}: OutlineSurfaceProps) {
  const section = useRef<HTMLElement>(null);
  const owner = useRef({});
  const feedback = useFeedback();
  const {platform} = useRenderEnvironment();
  const selected = session.selection?.kind === "blocks" ? session.selection.keys : [];
  const filtering = filter.trim() !== "";
  const writable = editable && !filtering;
  const destination = (row: Row): OutlineDestination | null => {
    const source = sourceForRow ? sourceForRow(row) : endpointForResource(row.endpoint);
    const position = session.position({endpoint: row.endpoint, edgeId: row.link.link_id, side: "after"});
    return source && position ? {source, position, occurrencePrefix: row.occurrencePrefix, path: row.path.slice(0,-1)} : null;
  };
  useLayoutEffect(() => session.registerSurface(owner.current, {rows, rootEndpoint,
    editable: writable, destination, publication}));
  useLayoutEffect(() => {
    if (session.selection?.kind !== "blocks") return;
    const key = session.selection.keys.at(-1);
    if (key) section.current?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(key)}"]`)?.focus({preventScroll: true});
  }, [session.selection]);
  const select = (key: string, extend = false) => {
    session.select({key, rows, extend});
    window.getSelection()?.removeAllRanges();
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, row: Row) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    const selectedHere = selected.includes(row.key);
    if (event.key === " " && !selectedHere) {event.preventDefault(); select(row.key); return;}
    if (!selectedHere) return;
    if (event.key === "Escape") {
      event.preventDefault(); session.clearSelection();
      event.currentTarget.querySelector<HTMLElement>("[data-outline-bullet]")?.focus(); return;
    }
    if ((usesMeta(platform) ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); session.executeCommand(event.shiftKey ? "redo" : "undo"); return;
    }
    if (event.key === "Enter" && !event.repeat && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); session.executeCommand("insert"); return;
    }
    const command = outlineStructuralCommand(event, platform);
    if (command) {event.preventDefault(); if (!event.repeat) session.executeCommand(command); return;}
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const next = rows[rows.indexOf(row)+direction]; if (next) select(next.key, event.shiftKey);
      return;
    }
    if (writable && ["Backspace", "Delete"].includes(event.key) && !event.repeat &&
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      const targets = rows.filter(candidate => selected.includes(candidate.key));
      if (targets.length === selected.length) session.unlinkOccurrences(targets, rows);
    }
  };
  const directRows = rows.filter(row => row.path.length === path.length+1 && row.path.slice(0,-1).every((id,i) => id === path[i]));
  const source = insertionSource === undefined ? endpointForResource(endpoint) : insertionSource;
  const tail = session.position({endpoint, edgeId: null, side: "after"});
  const trailing = source && tail ? {source, position: tail, occurrencePrefix, path} : null;
  const composer = session.composer;
  const surfaceComposer = composer !== null && insertionSourceRef(composer.destination.source) === endpoint &&
    composer.destination.occurrencePrefix === occurrencePrefix &&
    composer.destination.path.length === path.length &&
    composer.destination.path.every((id, index) => id === path[index])
      ? composer : null;
  const capturedAfter = surfaceComposer?.displayAfter ?? null;
  const predecessor = capturedAfter === null ? null
    : directRows.find(row => row.link.link_id === capturedAfter) ?? null;
  const composerRow = predecessor !== null && predecessor !== directRows.at(-1)
    ? predecessor.key : null;
  const originalPositionMissing = surfaceComposer !== null &&
    capturedAfter !== null && predecessor === null;
  const trailingDestination = surfaceComposer !== null && composerRow === null
    ? surfaceComposer.destination : trailing;
  return <OutlineSessionContext value={session}>
    <section ref={section} aria-label="linked notes">
      {selected.some(key => rows.some(row => row.key === key)) ? <FeedbackStatus announcement="Polite"
        content={{tone: "Neutral", title: "link selected. backspace or delete removes the connection; resources remain."}}/> : null}
      <ResourceOutlineList scope={occurrencePrefix} ariaLabel="note items" ancestorRef={endpoint}
        viewLocked={session.activeReference !== null} onRevealRoot={onRevealRoot}
        after={trailingDestination && (writable || surfaceComposer !== null) ? <>
          {originalPositionMissing ? <FeedbackStatus announcement="Polite" content={{
            tone: "Warning", title: "original insertion position is no longer available",
            message: "your input stays at its original destination. discard it before choosing another position.",
          }}/> : null}
          <OutlineInsertionLine session={session} destination={trailingDestination} publication={publication}/>
        </> : null}>
        {directRows.map(row => <SurfaceRow key={row.key} row={row} rows={rows} session={session}
          rootEndpoint={rootEndpoint} destination={destination(row)} editable={writable}
          historicalBranch={historicalBranch} publication={publication} selected={selected.includes(row.key)}
          hidden={filtering && !matchesPaneFilterQuery(filter, outlineFilterFields(row))}
          onSelect={extend => select(row.key, extend)} onKey={event => onKey(event,row)}
          composer={surfaceComposer !== null && composerRow === row.key
            ? surfaceComposer.destination : null}
          onPaste={(event) => {
            if (event.target !== event.currentTarget || !writable || !selected.includes(row.key)) return;
            const target = destination(row); if (!target) return;
            event.preventDefault(); void pasteOutline({session, destination: target, clipboard: event.clipboardData, publication})
              .catch((error: unknown) => {
                if (handleUnauthenticatedApiError(error)) return;
                if (!isApiError(error) && !(error instanceof TypeError || error instanceof SyntaxError)) throw error;
                feedback.offer({ needsAttention: true, undo: null, onDismiss: null,key: "outline-paste", announcement: "Polite", content: {tone: "Warning", title: "paste not applied", message: error.message}});
              });
          }}/>) }
      </ResourceOutlineList>
    </section>
  </OutlineSessionContext>;
}
function SurfaceRow({row, rows, session, rootEndpoint, destination, editable, historicalBranch, hidden,
  selected, onSelect, onKey, publication, composer, onPaste}: {
  row: Row; rows: readonly Row[]; session: OutlineSession; rootEndpoint: string;
  destination: OutlineDestination | null; editable: boolean; historicalBranch: boolean;
  hidden: boolean; selected: boolean; onSelect(extend: boolean): void;
  onKey(event: KeyboardEvent<HTMLElement>): void; publication?: DailyPublication;
  composer: OutlineDestination | null;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
}) {
  const text = useText(row.link.target.item.ref);
  const node = row.link.target;
  const historical = node.content.kind === "resource" && row.link.connection?.ordinal != null;
  const terminal = row.terminal !== null;
  const pending = session.pendingUnlinks.has(row.link.link_id);
  const placement = session.placement(row);
  const parentTitle = session.node(row.endpoint)?.item.label ?? "parent";
  const unlink: Extract<ActionDescriptor,{kind: "command"}> | null = row.link.connection?.origin === "user" &&
    row.link.connection.mutation?.kind === "unlink" && ((editable && session.canUnlink(row)) || pending)
    ? {kind: "command", id: "Outline.RemoveLink", label: pending ? "removing link…" : `unlink from ${parentTitle}`,
      disabled: pending, disabledReason: pending ? "removing link…" : undefined, restoreFocusOnClose: false,
      onSelect: () => session.unlinkOccurrences([row], rows)} : null;
  if (row.noteAuthority !== null && text?.gone && hasUnsavedText(node.item.ref))
    return <li><UnavailableTexts kind="note" refs={[node.item.ref]}/></li>;
  return <>
    <ResourceOutlineRow incoming={{kind: "edge", edge_id: row.link.link_id,
      origin: row.link.connection?.origin ?? "user", mutation: row.link.connection?.mutation ?? null,
      creation: row.link.connection?.creation ?? null}}
      item={node.item} occurrenceKey={row.key} connection={row.link.connection ?? undefined} edgeId={row.link.link_id}
      pageContent={node.content.kind === "page" ? node.content : null}
      noteAuthority={row.noteAuthority ?? undefined} noteEditable={editable && !pending} notePublication={publication}
      noteEmbeddedItem={node.content.kind === "note" ? node.content.embedded_item : null}
      noteKeys={!terminal && editable ? {selectBlock: () => onSelect(false),
        ...(structuralRow(row) ? {emptyBackspace: () => session.consume(row),
          join: (direction) => session.join({row,rows,direction})} : {})} : undefined}
      historical={historical} historicalBranch={historicalBranch} continuation={editable ? destination : null}
      authoredPlacement={placement} userUnlinkAction={unlink}
      rootProps={{hidden, tabIndex: 0, role: "listitem", "aria-label": `outline item: ${node.item.label}`,
        "data-selected": selected, onKeyDown: onKey, onPaste,
        onClick: event => {if (event.target instanceof Element && !event.target.closest("a,button,input,textarea,select,[contenteditable=true]")) onSelect(event.shiftKey);},
        onCopy: event => {if (event.target !== event.currentTarget || !selected) return;
          event.preventDefault(); session.copy({rows: rows.filter(row => session.selection?.kind === "blocks" && session.selection.keys.includes(row.key)), clipboard: event.clipboardData, cut: false});},
        onCut: event => {if (event.target !== event.currentTarget || !selected || !editable) return;
          event.preventDefault(); session.copy({rows: rows.filter(row => session.selection?.kind === "blocks" && session.selection.keys.includes(row.key)), clipboard: event.clipboardData, cut: true});}}}
      placement={{expanded: row.open, toggle: () => session.toggle({key: row.key, open: !row.open}),
        children: <ResourceDisclosure resourceRef={node.item.ref} occurrencePrefix={row.occurrencePrefix}
          path={row.path} rootEndpoint={rootEndpoint} readOnly={!editable} historicalBranch={historicalBranch || historical}
          suppressedEdgeIds={node.item.preview.annotation ? [node.item.preview.annotation.attachment_edge_id] : []}/>}}
      resourceDetails={pending ? <FeedbackStatus announcement="None" content={{tone: "Neutral", title: "removing link…"}}/> : undefined}/>
    {composer ? <li className={styles.composer}><OutlineInsertionLine session={session} destination={composer} publication={publication}/></li> : null}
  </>;
}
