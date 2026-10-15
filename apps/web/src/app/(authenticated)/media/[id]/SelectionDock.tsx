"use client";

import { useCallback, useEffect } from "react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import NoteEditor from "@/components/notes/NoteEditor";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateResource } from "@/lib/resources/activation";
import { resolveResourceItem } from "@/lib/resources/items";
import type { Reader } from "@/lib/documentReader/runtime";
import type { HighlightColor } from "@/lib/documentReader/model";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { projectActionControlState } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import { useFeedback } from "@/components/feedback/Feedback";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs } from "./useAnnotationVerbs";
import { initialBody, isEmptyParagraph } from "./selectionDrafts";
import styles from "./media.module.css";

const COLOURS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];
const COMPOSER_ACTIONS = new Set(["Chat", "HighlightNote", "EditHighlight"]);

export function Colours({ selected, onSelect, disabled = false, persisted = true }: {
  readonly selected: HighlightColor | null;
  readonly onSelect: (color: HighlightColor) => void;
  readonly disabled?: boolean;
  readonly persisted?: boolean;
}) {
  return <div className={styles.colours} role="group" aria-label="highlight colours">
    {COLOURS.map((color) => <button key={color} type="button" className={styles.colour}
      style={{ background: `var(--highlight-${color})` }} aria-label={`${color} highlight`}
      aria-pressed={selected === color} disabled={disabled || (persisted && selected === color)}
      onClick={() => onSelect(color)} />)}
  </div>;
}

/** The canonical action model, rendered directly; this surface has no menu to close. */
function HighlightActions({ id, blocked, size }: { readonly id: string; readonly blocked: boolean; readonly size: "sm" | "lg" }) {
  const { options, onOpenChange } = useResourceActionMenu(`highlight:${id}`);
  useEffect(() => {
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [onOpenChange]);
  return <>
    {options.filter((action) => !COMPOSER_ACTIONS.has(action.id)).map((action) => {
      if (action.kind === "custom") return <div key={action.id}>{action.render({ triggerEl: null, closeMenu: () => {}, closeMenuWithoutFocus: () => {} })}</div>;
      const control = projectActionControlState(action.label, action.kind === "command" ? action.state : undefined);
      return <div key={action.id} className={styles.selectionAction}>
        {action.kind === "link" ? <Button asChild variant="ghost" size={size}><a href={action.href} aria-disabled={action.disabled || blocked || undefined}
          onClick={(event) => { if (action.disabled || blocked) event.preventDefault(); else action.onSelect?.({ triggerEl: null }); }}>{action.label}</a></Button>
          : <Button variant="ghost" size={size} disabled={action.disabled || blocked}
            aria-pressed={control.barPressed} aria-expanded={control.barExpanded} aria-controls={control.barControls}
            onClick={(event) => action.onSelect({ triggerEl: event.currentTarget })}>{action.label}</Button>}
        {action.disabledReason ? <span className={styles.composerHint}>{action.disabledReason}</span> : null}
      </div>;
    })}
  </>;
}

export default function SelectionDock({ verbs, store, reader, isMobile, canQuote }: {
  readonly verbs: AnnotationVerbs;
  readonly store: AnnotationStore;
  readonly reader: Reader;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
}) {
  const { composer, menu } = verbs;
  const { draft, opening } = composer;
  const feedback = useFeedback();
  const { activateTarget } = requirePaneRuntime(usePaneRuntime(), "SelectionDock");
  const openEmbed = (ref: string, disposition: WorkspaceTargetDisposition) => {
    const unavailable = () => feedback.publish({ kind: "Hud", content: { tone: "Warning", title: "Linked object couldn’t be opened" } });
    void resolveResourceItem(ref).then(
      (item) => { if (!activateResource(item.activation, { disposition, activateTarget })) unavailable(); },
      (error: unknown) => { if (!handleUnauthenticatedApiError(error)) unavailable(); },
    );
  };
  const anchor = useCallback(() => {
    if (!draft) return null;
    const measured = reader.measurePassage(draft.passage);
    if (measured) return measured;
    const bounds = reader.measureBounds();
    return bounds ? { rect: null, lines: [], bounds } : null;
  }, [draft, reader]);
  const chooserAnchor = useCallback(() => {
    if (!menu?.marks[0]) return null;
    return reader.measurePassage({ identity: menu.identity, anchor: menu.marks[0].anchor });
  }, [menu, reader]);
  const blocked = !draft || draft.load !== "Ready" || draft.operation !== null;
  const deleting = draft?.operation?.kind === "Delete" && (draft.operation.pending || draft.issue?.kind === "Unknown");
  const emptyExisting = draft?.base.kind === "Present" && isEmptyParagraph(draft.body);
  const dirty = draft && JSON.stringify(draft.body.body_pm_json) !== JSON.stringify(initialBody(draft.base).body_pm_json);
  const size = isMobile ? "lg" : "sm";
  return <>
    {draft && opening ? <FloatingActionSurface open anchor={anchor} subscribeAnchor={reader.subscribe}
      strategy="text-selection" role="group" label="passage annotation" className={styles.composerSurface}
      onDismiss={composer.dismiss}>
      {(placed, anchorState) => {
        const unavailable = anchorState === "unavailable";
        const commandBlocked = blocked || unavailable && !draft.highlightId;
        return (
          <div data-selection-composer="true" className={styles.selectionComposer}>
            <div className={styles.passageCue}>{draft.passage.quote || "selected passage"}</div>
            {unavailable ? <div role="status" className={styles.composerHint}>this passage is no longer available. your draft is kept.</div> : null}
            <div className={styles.dock}>
              <Colours selected={draft.highlight?.color ?? "yellow"} persisted={draft.highlightId !== null}
                disabled={commandBlocked || draft.highlight?.is_owner === false} onSelect={verbs.highlight} />
              <Button variant="ghost" size={size} onClick={() => {
                void copyText(draft.passage.quote).catch(() => feedback.publish({ kind: "Hud", content: { tone: "Danger", title: "passage couldn’t be copied." } }));
              }}>copy text</Button>
              <Button variant="ghost" size={size} disabled={commandBlocked} onClick={composer.save}>save note</Button>
              {canQuote ? <>
                <Button variant="ghost" size={size} disabled={commandBlocked} onClick={composer.newChat}>new chat</Button>
                <Button variant="ghost" size={size} disabled={commandBlocked} onClick={verbs.ask}>existing chat…</Button>
              </> : null}
              {draft.highlightId ? <HighlightActions id={draft.highlightId} blocked={blocked} size={size} /> : <>
                <Button variant="ghost" size={size} disabled={commandBlocked} onClick={verbs.linkSelection}>link</Button>
                <Button variant="ghost" size={size} disabled={commandBlocked} onClick={verbs.learn}>learn</Button>
                <Button variant="ghost" size={size} disabled={commandBlocked} onClick={(event) => verbs.share(event.currentTarget)}>share</Button>
              </>}
            </div>
            <div className={styles.selectionInput}>
              {draft.load === "Ready" ? <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`}
                body={draft.body} revision={draft.revision} label="Passage note"
                placeholder="add a note or ask about this passage…" compact editable={!deleting}
                focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
                onEdit={composer.edit} onSelectionChange={composer.selection}
                history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
                onSave={composer.save} onNewChat={canQuote ? composer.newChat : undefined} onEmptyBackspace={composer.deleteNote}
                onOpenEmbed={openEmbed} />
                : <div role="status">{draft.load === "Loading" ? "loading your note…" : "your note could not be loaded."}</div>}
            </div>
            {draft.issue ? <div role="alert" className={styles.composerHint}>
              <span>{draft.issue.message}</span>
              {draft.issue.kind === "Conflict" ? <div className={styles.dock}>
                <Button size={size} variant="ghost" onClick={() => composer.resolveConflict(true)}>use saved note</Button>
                <Button size={size} variant="ghost" onClick={() => composer.resolveConflict(false)}>save my draft instead</Button>
                {draft.issue.saved.kind === "Present" ? <blockquote>{draft.issue.saved.body.body_text}</blockquote> : <span>the saved note is absent.</span>}
              </div> : <div className={styles.dock}>
                {draft.operation || draft.load === "Failed" ? <Button size={size} variant="ghost" onClick={composer.retry}>{draft.operation ? "retry same request" : "reload note"}</Button> : <span>review your draft, then choose save note or new chat.</span>}
              </div>}
            </div> : <div role="status" className={styles.composerHint}>
              {draft.status ? <span>{draft.status}</span> : null}
              {dirty && !draft.operation ? <span> changes not saved</span> : null}
            </div>}
            <div className={styles.composerHint}>enter saves · shift+enter new line · {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "ctrl"}+enter new chat</div>
            {emptyExisting ? <div className={styles.composerHint}>
              backspace deletes this note and its links. the highlight stays.
              <Button size={size} variant="ghost" disabled={blocked} onClick={composer.deleteNote}>delete empty note</Button>
            </div> : null}
          </div>
        );
      }}
    </FloatingActionSurface> : null}
    {menu ? <FloatingActionSurface open anchor={chooserAnchor} subscribeAnchor={reader.subscribe} role="group" label="choose highlight" onDismiss={verbs.closeMenu}>
      <div className={styles.chooser}>
        <span>choose highlight</span>
        {menu.marks.map((mark) => <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
          {mark.color} · {store.highlight(mark.id)?.is_owner ? "your highlight" : "shared highlight"} · {store.highlight(mark.id)?.quote ?? "highlight"}
        </button>)}
      </div>
    </FloatingActionSurface> : null}
    <Dialog open={verbs.recolouring !== null} title="Edit highlight" onClose={() => verbs.recolour(null)}>
      <Colours selected={verbs.recolouring ? store.highlight(verbs.recolouring)?.color ?? null : null} onSelect={verbs.recolour} />
    </Dialog>
    <ConversationDestinationOverlay open={verbs.choosingChat !== null} onClose={() => verbs.chat(null)} onSelectConversation={verbs.chat} />
  </>;
}
