"use client";

import { useCallback, useEffect, useId, type KeyboardEvent } from "react";
import { BookOpenText, Copy, Link2, MessageCirclePlus, MessagesSquare, Save, Share2 } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import ResourceBody from "@/components/resources/ResourceBody";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import Tooltip from "@/components/ui/Tooltip";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import { projectActionControlState, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours } from "./HighlightColourPicker";
import { initialBody, isEmptyParagraph } from "./selectionDrafts";
import styles from "./media.module.css";

const COMPOSER_ACTIONS = new Set(["Chat", "HighlightNote", "EditHighlight"]);

/** One local projection preserves command state, native navigation and unavailable help. */
function SelectionAction({ action, blockedReason = null, help }: {
  readonly action: Exclude<ActionDescriptor, { kind: "custom" }>;
  readonly blockedReason?: string | null;
  readonly help?: string;
}) {
  const reasonId = useId();
  if (!action.icon) throw new Error(`Selection action ${action.id} has no icon`);
  const control = projectActionControlState(action.label, action.kind === "command" ? action.state : undefined);
  const reason = blockedReason ?? (action.disabled ? action.disabledReason ?? "this action is unavailable." : null);
  const description = help ?? control.menuLabel;
  const className = [styles.selectionIcon, control.active && styles.selectionIconActive,
    action.tone === "danger" && styles.selectionIconDanger].filter(Boolean).join(" ");
  const icon = <>
    <span aria-hidden="true">{action.icon}</span>
    {action.indicator ? <span className={styles.selectionStatusMarker} aria-hidden="true" /> : null}
  </>;
  return <>
    <Tooltip text={reason ? `${description}. ${reason}` : description} renderTrigger={(tooltip) => {
      const common = {
        ...tooltip,
        "aria-label": action.label,
        "aria-describedby": tooltip["aria-describedby"] ?? (reason ? reasonId : undefined),
        "aria-disabled": reason !== null || undefined,
        "data-action-id": action.id,
        onKeyDown: (event: KeyboardEvent) => {
          if (reason && (event.key === "Enter" || event.key === " ")) event.preventDefault();
        },
      };
      return action.kind === "link" ? (
        <Button asChild variant="ghost" size="sm" iconOnly className={className}>
          <a {...common} href={reason ? undefined : action.href} role="link" tabIndex={0}
            onClick={(event) => { if (reason) event.preventDefault(); else action.onSelect?.({ triggerEl: null }); }}>{icon}</a>
        </Button>
      ) : (
        <Button {...common} variant="ghost" size="sm" iconOnly className={className}
          aria-pressed={control.barPressed} aria-expanded={control.barExpanded} aria-controls={control.barControls}
          onClick={(event) => { if (reason) event.preventDefault(); else action.onSelect({ triggerEl: event.currentTarget }); }}>{icon}</Button>
      );
    }} />
    {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
  </>;
}

/** The canonical action model, rendered directly; this surface has no menu to close. */
function HighlightActions({ id, blockedReason }: { readonly id: string; readonly blockedReason: string | null }) {
  const { options, onOpenChange } = useResourceActionMenu(`highlight:${id}`);
  useEffect(() => {
    onOpenChange(true);
    return () => onOpenChange(false);
  }, [onOpenChange]);
  return <>
    {options.filter((action) => !COMPOSER_ACTIONS.has(action.id)).map((action) => {
      if (action.kind === "custom") return <div key={action.id}>{action.render({ triggerEl: null, closeMenu: () => {}, closeMenuWithoutFocus: () => {}, presentation: "bar" })}</div>;
      return <SelectionAction key={action.id} action={action} blockedReason={blockedReason}
        help={action.id === "LearnHighlight" ? "create a dossier from this passage" : undefined} />;
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
  const feedback = useFeedback();
  const { draft, opening } = composer;
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const sourceChanged = draft !== null && identity !== null && draft.passage.identity !== identity;
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
  const highlight = draft?.highlight ?? (draft?.highlightId ? store.highlight(draft.highlightId) : null);
  const map = store.getState().map;
  const overlapItems = menu && map.status !== "loading" && map.data
    ? map.data.evidence.passage_groups.flatMap((group) => group.items) : [];
  const size = isMobile ? "lg" : "sm";
  return <>
    {draft && opening ? <FloatingActionSurface open anchor={anchor} subscribeAnchor={reader.subscribe}
      strategy="text-selection" role="group" label="passage annotation" className={styles.composerSurface}
      onDismiss={composer.dismiss}>
      {(placed, anchorState) => {
        const unavailable = anchorState === "unavailable";
        const blockedReason = sourceChanged ? "this post changed. select the passage again."
          : draft.load !== "Ready" ? "load your note before using this action."
          : draft.operation ? "finish or retry the current request first."
          : unavailable && !draft.highlightId ? "this passage is no longer available." : null;
        const highlightReason = blockedReason ?? (highlight?.is_owner === false ? "only your own highlight can be changed." : null);
        const hasMessage = draft.body.body_text.trim().length > 0;
        return (
          <div data-selection-composer="true" className={styles.selectionComposer}>
            <div className={styles.passageCue}>{draft.passage.quote || "selected passage"}</div>
            {unavailable || sourceChanged ? <FeedbackStatus content={{ tone: "Neutral", title: sourceChanged ? "this post changed. select the passage again." : "this passage is no longer available", message: "your draft is kept." }} announcement="Polite" /> : null}
            <div className={styles.dock}>
              <HighlightColourPicker key={opening.id} selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null}
                disabledReason={highlightReason} onSelect={verbs.highlight} />
              <SelectionAction blockedReason={blocked ? blockedReason : null} action={{ kind: "command", id: "CopyPassage", label: "copy passage", icon: <Copy size={16} aria-hidden="true" />, onSelect: () => {
                void copyText(draft.passage.quote).catch(() => feedback.offer({ key: "reader-copy-passage", announcement: "Polite", content: { tone: "Danger", title: "passage couldn’t be copied" } }));
              } }} />
              <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SavePassageNote", label: draft.base.kind === "Absent" && isEmptyParagraph(draft.body) ? "save highlight" : "save note",
                icon: <Save size={16} aria-hidden="true" />, onSelect: composer.save }} />
              {canQuote ? <>
                <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "NewPassageChat", label: hasMessage ? "send text in new chat" : "new chat with passage",
                  icon: <MessageCirclePlus size={16} aria-hidden="true" />, onSelect: composer.newChat }} />
                <SelectionAction blockedReason={blockedReason} help="choose an existing chat to open this passage without sending your note"
                  action={{ kind: "command", id: "ExistingPassageChat", label: "choose existing chat", icon: <MessagesSquare size={16} aria-hidden="true" />, onSelect: verbs.ask }} />
              </> : null}
              {draft.highlightId ? <HighlightActions id={draft.highlightId} blockedReason={blockedReason} /> : <>
                <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "LinkPassage", label: "link passage", icon: <Link2 size={16} aria-hidden="true" />, onSelect: verbs.linkSelection }} />
                <SelectionAction blockedReason={blockedReason} help="create a dossier from this passage"
                  action={{ kind: "command", id: "LearnPassage", label: "learn from passage", icon: <BookOpenText size={16} aria-hidden="true" />, onSelect: verbs.learn }} />
                <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
                  onSelect: ({ triggerEl }) => verbs.share(triggerEl) }} />
              </>}
            </div>
            <div className={styles.selectionInput}>
              {draft.load === "Ready" ? <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`}
                body={draft.body} embeddedItem={draft.base.kind === "Present" ? draft.base.embeddedItem : null} revision={draft.revision} label="Passage note"
                placeholder="add a note or ask about this passage…" compact editable={!deleting}
                focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
                onEdit={composer.edit} onSelectionChange={composer.selection}
                history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
                onSave={composer.save} onNewChat={canQuote ? composer.newChat : undefined} onEmptyBackspace={composer.deleteNote}
                />
                : !draft.issue ? <FeedbackStatus content={{ tone: "Neutral", title: "loading your note…" }} announcement="Polite" /> : null}
            </div>
            {draft.issue ? <>
              <FeedbackNotice content={{ tone: "Warning", title: draft.issue.message,
                message: draft.issue.kind !== "Conflict" && !draft.operation && draft.load === "Ready" ? "review your draft, then choose save note or new chat." : undefined,
              }} announcement="Polite" actions={draft.issue.kind === "Conflict" ? [
                { label: "use saved note", onClick: () => composer.resolveConflict(true) },
                { label: "save my draft instead", onClick: () => composer.resolveConflict(false) },
              ] : draft.operation || draft.load !== "Ready" ? [{
                label: draft.operation ? "retry same request" : "reload note", onClick: composer.retry,
                commandKey: draft.operation?.id, busy: Boolean(draft.operation?.pending) || draft.load === "Loading",
              }] : undefined} />
              {draft.issue.kind === "Conflict" ? draft.issue.saved.kind === "Present"
                ? <blockquote className={styles.composerHint}>{draft.issue.saved.body.body_text}</blockquote>
                : <span className={styles.composerHint}>the saved note is absent.</span> : null}
            </> : draft.status || (dirty && !draft.operation) ? <FeedbackStatus
              content={{ tone: "Neutral", title: draft.status ?? "changes not saved",
                message: draft.status && dirty && !draft.operation ? "changes not saved" : undefined }} announcement="Polite"
            /> : null}
            <div className={styles.composerHint}>enter saves · shift+enter new line · {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "ctrl"}+enter {hasMessage ? "sends text in new chat" : "opens chat with passage"}</div>
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
        {menu.marks.map((mark) => {
          const highlight = store.highlight(mark.id);
          const item = overlapItems.find((item): item is Schema<"ReaderEvidenceHighlightOut"> => item.kind === "Highlight" && item.highlight_id === mark.id);
          return <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
            {item ? <ResourceBody body={item.item.preview.body} /> : "highlight"}
            <span>{mark.color} · {highlight?.is_owner ? "your highlight" : "shared highlight"}</span>
          </button>;
        })}
      </div>
    </FloatingActionSurface> : null}
    <Dialog open={verbs.recolouring !== null} title="Edit highlight" onClose={() => verbs.recolour(null)}>
      <Colours selected={verbs.recolouring ? store.getState().decorations.marks.find((mark) => mark.id === verbs.recolouring)?.color ?? null : null} onSelect={verbs.recolour} />
    </Dialog>
    <ConversationDestinationOverlay open={verbs.choosingChat !== null} onClose={() => verbs.chat(null)} onSelectConversation={verbs.chat} />
  </>;
}
