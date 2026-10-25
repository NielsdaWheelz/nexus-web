"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from "react";
import { ChevronDown, Copy, MessageCircle, MessagesSquare, Move, NotebookPen, Save, Share2, Trash2 } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { FeedbackNotice, FeedbackStatus, useFeedback, type FeedbackContextValue } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import { AttachedNotes, PLACEMENT_COPY } from "@/lib/documentReader/chrome/ReaderAnnotation";
import { PaneReturnVisitScope, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { prepareActionSelect, type ActionDescriptor, type MenuContent, type MenuSource } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { bodyHasContent } from "@nexus/authored/body";
import type { MediaAnnotations } from "./annotations";
import type { AnnotationVerbs, MobileSelection } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours, HighlightButton } from "./HighlightColourPicker";
import styles from "./media.module.css";


function copy(feedback: FeedbackContextValue, text: string, title: string) {
  void copyText(text).catch(() => feedback.receipt({ tone: "Danger", title }));
}

type SelectionActionPresentation =
  | { readonly action: Extract<ActionDescriptor, { kind: "command" }>; readonly unavailable?: never }
  | { readonly action: null; readonly unavailable: {
      readonly id: string; readonly label: string; readonly icon: ReactElement; readonly reason: string;
      readonly hasPopup: "dialog";
    } };

/** Primary commands share the overflow's descriptors and the common button contract. */
function SelectionAction({ action, unavailable, help, busy, buttonRef }: SelectionActionPresentation & {
  readonly help: string;
  readonly busy: boolean;
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const reasonId = useId();
  const presentation = action ?? unavailable;
  if (!presentation.icon) throw new Error(`Selection action ${presentation.id} has no icon`);
  const reason = action ? action.disabled ? action.disabledReason ?? "this action is unavailable." : null : unavailable.reason;
  const activate = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (!action || action.disabled) return;
    const detail = prepareActionSelect(event, event.currentTarget);
    if (detail) action.onSelect(detail);
  };
  return <>
    <Button ref={buttonRef} aria-disabled={reason !== null || undefined} iconOnly icon={presentation.icon} className={styles.selectionIcon}
      tooltip={{ text: reason ? `${help}. ${reason}` : help }} aria-label={presentation.label}
      aria-describedby={reason ? reasonId : undefined} data-action-id={presentation.id} aria-busy={busy || action?.busy || undefined}
      aria-haspopup={presentation.hasPopup}
      onClick={activate} onKeyDown={activate} />
    {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
  </>;
}

/** The native invoker survives ensure; only capability absence removes it. */
function SelectionShare({ returnFocus, ...props }: SelectionActionPresentation & {
  readonly help: string;
  readonly busy: boolean;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  useActionFocusRecovery(trigger, returnFocus);
  return <SelectionAction {...props} buttonRef={trigger} />;
}

/** A press freezes one source capture; only its native click may execute it. */
function MobileSelectionActions({ verbs, reader, canQuote, sharePiece }: {
  readonly verbs: AnnotationVerbs;
  readonly reader: Reader;
  readonly canQuote: boolean;
  readonly sharePiece: ((trigger: HTMLElement | null) => void) | null;
}) {
  const feedback = useFeedback();
  const ownerId = useId();
  const row = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [menuSubject, setMenuSubject] = useState<MobileSelection | null>(null);
  const subject = menuSubject && verbs.selectionCurrent(menuSubject) ? menuSubject : verbs.mobileSelection;
  const current = useRef(verbs);
  current.current = verbs;
  const press = useRef<{
    subject: MobileSelection; control: HTMLButtonElement; pointer: number; x: number; y: number; released: boolean;
  } | null>(null);
  const focus = useRef<{ subject: MobileSelection; control: HTMLButtonElement } | null>(null);
  const transfer = useRef<MobileSelection | null>(null);
  const menuCommand = useRef<MobileSelection | null>(null);
  const anchor = useCallback(() => subject ? reader.measurePassage(subject.capture) : null, [reader, subject]);
  const cancelPress = useCallback(() => {
    press.current = null;
    focus.current = null;
    transfer.current = null;
    current.current.cancelSelectionActivation();
  }, []);
  useEffect(() => {
    if (!verbs.selectionVisible) { press.current = null; focus.current = null; transfer.current = null; return; }
    const move = (event: globalThis.PointerEvent) => {
      const held = press.current;
      if (held && (held.pointer !== event.pointerId || Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8)) cancelPress();
    };
    const up = (event: globalThis.PointerEvent) => {
      const held = press.current;
      if (!held || held.pointer !== event.pointerId) return;
      if (!event.composedPath().includes(held.control)) cancelPress();
      else held.released = true;
    };
    const cancel = (event: globalThis.PointerEvent) => { if (press.current?.pointer === event.pointerId) cancelPress(); };
    const nextPress = () => { if (press.current) cancelPress(); };
    const tab = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || !current.current.selectionVisible) return;
      const owned = focus.current;
      transfer.current = owned && document.activeElement === owned.control && current.current.selectionCurrent(owned.subject)
        ? owned.subject : current.current.captureSelection();
    };
    const arrival = (event: FocusEvent) => {
      if (event.target instanceof Node && row.current?.contains(event.target)) return;
      focus.current = null;
      if (transfer.current) { transfer.current = null; current.current.cancelSelectionActivation(); }
    };
    const scroll = (event: Event) => {
      const panelId = menuTrigger.current?.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      const surface = row.current?.closest('[data-strategy="mobile-selection-actions"]');
      if (event.target instanceof Node && (surface?.contains(event.target) || panel?.contains(event.target))) return;
      if (press.current || focus.current || menuTrigger.current?.getAttribute("aria-expanded") === "true") cancelPress();
    };
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    window.addEventListener("pointerdown", nextPress, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", tab, true);
    document.addEventListener("focusin", arrival, true);
    return () => {
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("pointerdown", nextPress, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", tab, true);
      document.removeEventListener("focusin", arrival, true);
    };
  }, [cancelPress, verbs.selectionVisible]);
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || event.currentTarget.disabled) return;
    const captured = verbs.captureSelection();
    if (!captured) return;
    press.current = { subject: captured, control: event.currentTarget, pointer: event.pointerId,
      x: event.clientX, y: event.clientY, released: false };
    transfer.current = captured;
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.repeat) { event.preventDefault(); return; }
    if (focus.current?.control === event.currentTarget && verbs.selectionCurrent(focus.current.subject)) return;
    const captured = verbs.captureSelection();
    if (captured) focus.current = { subject: captured, control: event.currentTarget };
  };
  const focusControl = (control: HTMLButtonElement) => {
    const captured = transfer.current;
    transfer.current = null;
    if (captured && verbs.selectionCurrent(captured)) focus.current = { subject: captured, control };
    else focus.current = subject && verbs.ownSelectionFocus(subject) ? { subject, control } : null;
  };
  const activate = (event: MouseEvent<HTMLButtonElement>, command: (captured: MobileSelection) => void) => {
    const held = press.current;
    press.current = null;
    const captured = event.detail > 0
      ? held?.released && held.control === event.currentTarget &&
        (!(event.nativeEvent instanceof globalThis.PointerEvent) || event.nativeEvent.pointerId <= 0 || event.nativeEvent.pointerId === held.pointer)
        ? held.subject : null
      : focus.current?.control === event.currentTarget ? focus.current.subject : null;
    if (!captured || !verbs.selectionCurrent(captured)) { event.preventDefault(); return; }
    command(captured);
  };
  const content = (captured: MobileSelection): MenuContent => {
    const options: ActionDescriptor[] = [
      { kind: "command", id: "CopyPassage", label: "copy passage", icon: <Copy size={16} aria-hidden="true" />,
        onSelect: () => { if (verbs.selectionCurrent(captured)) copy(feedback, captured.capture.quote, "passage couldn’t be copied"); } },
      { kind: "custom", id: "HighlightColours", label: "highlight colour", render: ({ closeMenu }) => (
        <Colours selected={null} persisted={false} size="comfortable"
          onSelect={(color) => { closeMenu(); menuCommand.current = captured; verbs.highlightSelection(captured, color); }} />
      ) },
      sharePiece === null
        ? { kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
          onSelect: ({ triggerEl }) => { menuCommand.current = captured; verbs.shareSelection(captured, triggerEl); } }
        : { kind: "command", id: "SharePiece", label: "share piece", icon: <Share2 size={16} aria-hidden="true" />,
          onSelect: ({ triggerEl }) => {
            if (!verbs.selectionCurrent(captured)) return;
            menuCommand.current = captured;
            sharePiece(triggerEl);
          } },
    ];
    return { sections: [{ id: "Passage", label: null, options }] };
  };
  const source: MenuSource = {
    kind: "Immediate", subjectKey: subject ? JSON.stringify([subject.id, subject.capture]) : ownerId,
    title: "passage actions", content: subject ? content(subject) : { sections: [] },
  };
  const confirming = verbs.bounds?.phase === "Selecting" || verbs.composer.reselection !== null;
  return <ActionMenu source={source} label="more passage actions" triggerRef={(node) => { menuTrigger.current = node; }}
    onOpenChange={(open) => {
      if (open) return;
      const closed = menuSubject;
      setMenuSubject(null);
      // ActionMenu closes before dispatching its chosen command. Let that command
      // transfer ownership before retiring an otherwise abandoned menu capture.
      queueMicrotask(() => {
        if (menuCommand.current === closed) { menuCommand.current = null; return; }
        if (!closed || !current.current.selectionVisible || !current.current.selectionCurrent(closed)) return;
        current.current.cancelSelectionActivation();
        reader.focusSource();
      });
    }}
    renderTrigger={(trigger) => (
      <FloatingActionSurface open={verbs.selectionVisible && subject !== null} anchor={anchor} subscribeAnchor={reader.subscribe}
        strategy="mobile-selection-actions" selectionSession={subject?.id ?? null}
        role="group" label={confirming ? "confirm passage selection" : "passage actions"} onDismiss={verbs.dismissSelection}>
        <div ref={row} className={styles.mobileSelectionActions}>
          {confirming ? <>
            <Button size="comfortable" emphasis="strong" onPointerDown={pointerDown} onKeyDown={keyDown}
              onFocus={(event) => focusControl(event.currentTarget)} onClick={(event) => activate(event, verbs.applySelection)}>apply selection</Button>
            <Button size="comfortable" onClick={verbs.bounds ? verbs.cancelBounds : verbs.dismissSelection}>cancel</Button>
          </> : <>
            {/* every selection becomes a new independent highlight, so the command never shows a persisted colour. */}
            <HighlightButton selected="yellow" persisted={false} disabledReason={null} busy={false}
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.highlightSelection(captured, "yellow"))} />
            <Button iconOnly icon={<NotebookPen size={16} aria-hidden="true" />} className={styles.selectionIcon} aria-label="open passage note"
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.composeSelection(captured, "Note"))} />
            {canQuote ? <Button iconOnly icon={<MessageCircle size={16} aria-hidden="true" />} className={styles.selectionIcon} aria-label="ask about passage"
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.composeSelection(captured, "Ask"))} /> : null}
            <OverflowMenuButton {...trigger} className={styles.selectionIcon} onPointerDown={pointerDown} onKeyDown={keyDown}
              onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => { menuCommand.current = null; setMenuSubject(captured); trigger.onClick(event); })} />
          </>}
        </div>
      </FloatingActionSurface>
    )} />;
}

export default function SelectionDock({ verbs, store, reader, isMobile, canQuote, returnFocus, sharePiece }: {
  readonly verbs: AnnotationVerbs;
  readonly store: MediaAnnotations;
  readonly reader: Reader;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
  readonly returnFocus: () => HTMLElement | null;
  readonly sharePiece: ((trigger: HTMLElement | null) => void) | null;
}) {
  const { composer, menu } = verbs;
  const visitScope = usePaneVisitWorkScope();
  const feedback = useFeedback();
  const { draft, opening, annotation } = composer;
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const copyTrigger = useRef<HTMLButtonElement | null>(null);
  const destinationTrigger = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();
  const pickerAnchor = useCallback(() => isMobile ? moreTrigger.current : destinationTrigger.current, [isMobile]);
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const sourceChanged = draft?.issue?.kind === "Source" || (draft !== null && draft.highlightId === null && identity !== null && draft.passage.identity !== identity);
  const anchor = useCallback(() => {
    if (!draft) return null;
    const passage = annotation?.placement.kind === "placed" ? { identity: draft.passage.identity, anchor: annotation.placement.anchor } : draft.passage;
    const measured = reader.measurePassage(passage);
    if (measured) return measured;
    const bounds = reader.measureBounds();
    return bounds ? { rect: null, lines: [], bounds } : null;
  }, [annotation, draft, reader]);
  const chooserAnchor = useCallback(() => {
    if (!menu?.marks[0]) return null;
    return reader.measurePassage({ identity: menu.identity, anchor: menu.marks[0].anchor });
  }, [menu, reader]);
  const renderComposer = (placed: boolean, unavailable: boolean, headerOnly = false) => {
    if (!draft || !opening) return null;
    const hasNote = bodyHasContent(draft.body);
    const failed = draft.issue?.kind === "Failed" ? draft.issue : null;
    const blockedReason = failed ? "retry saving first. your words are kept."
      : sourceChanged ? "the source changed. your words are kept; select the passage again."
      : draft.chatIssue?.kind === "Passage" || draft.chatIssue?.kind === "Source" ? "select the passage again before saving or sending."
      : draft.attachmentActive ? "finish or discard the attachment before saving or sending."
      : draft.referenceActive ? (isMobile ? "finish linking before using this action." : "finish linking or press escape to keep this as prose.")
      : draft.operation ? "finish or retry the current request first."
      : unavailable && !draft.highlightId ? "this passage is no longer available." : null;
    const destination = draft.destination;
    const selected = destination.kind === "Selected" ? destination : null;
    const preparing = draft.chatAttempt?.kind === "Preparing" || draft.operation?.kind === "Chat" || draft.operation?.kind === "Ensure" || (selected?.snapshot.kind === "Loading");
    const sending = composer.ownChatCommand && composer.chatState.kind === "Busy";
    const continuationBlocked = (selected !== null && selected.snapshot.kind !== "Ready") || (hasNote && composer.chat?.target.kind === "Blocked");
    const hasMessage = convertReaderQuestion(draft.body).kind !== "Blank";
    const chatLabel = selected ? `${hasMessage ? "send to" : "open in"} “${selected.title}”` : "choose existing chat";
    const chatIssue = draft.chatIssue;
    const commandRecovery = composer.ownChatCommand && (composer.chatState.kind === "Unconfirmed" || composer.chatState.kind === "RefreshRequired") ? composer.chatState : null;
    const blockedChat = composer.chat?.target.kind === "Blocked" ? composer.chat.target.reason === "AssistantRunning"
      ? "this chat is still responding" : "this chat can’t accept a reply here"
      : selected?.snapshot.kind === "RefreshRequired" ? "this chat changed"
      : selected?.snapshot.kind === "Failed" ? "couldn’t load chat" : null;
    const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "cmd" : "ctrl";
    const command = (id: string, label: string, icon: ActionDescriptor["icon"], onSelect: Extract<ActionDescriptor, { kind: "command" }>["onSelect"], reason: string | null): Extract<ActionDescriptor, { kind: "command" }> => ({
      kind: "command", id, label, icon, onSelect, disabled: reason !== null, disabledReason: reason ?? undefined,
    });
    // a failed local commit is retried as the same frozen command, never saved again.
    const saveAction = failed ? command("RetryPassageSave", "retry saving", <Save size={16} aria-hidden="true" />, failed.retry, null)
      : command("SavePassageNote", draft.highlightId === null && !hasNote ? "save highlight" : "save note",
        <Save size={16} aria-hidden="true" />, composer.save, blockedReason ?? (draft.highlightId !== null && !hasNote ? "write a note to add it to this highlight." : null));
    const newLabel = hasMessage ? "send in new chat" : "open in new chat";
    const chatReason = blockedReason ?? ((hasMessage ? composer.chatLocked : composer.readerChatLocked) ? "another chat change is still in progress." : null);
    const existingReason = chatReason ?? (preparing || destination.kind === "Resolving" ? "loading chat…" : continuationBlocked ? "this chat is not ready for this action." : null);
    const newAction = command("NewChat", newLabel, <MessageCircle size={16} aria-hidden="true" />, ({ openIntent }) => composer.newChat(openIntent), chatReason);
    const existingAction = command("ExistingChat", chatLabel, <MessagesSquare size={16} aria-hidden="true" />, ({ openIntent }) => composer.continueChat(openIntent), existingReason);
    const chooseAction = { ...command("ChooseChat", "choose existing chat", <ChevronDown size={16} aria-hidden="true" />, composer.chooseChat,
      blockedReason ?? (composer.chatLocked ? "another chat change is still in progress." : null)), restoreFocusOnClose: false };
    const copyAction = command("CopyPassage", "copy passage", <Copy size={16} aria-hidden="true" />, () => copy(feedback, draft.passage.quote, "passage couldn’t be copied"),
      draft.passage.quote.trim().length > 0 ? null : "this highlight has no text to copy");
    // sharing a new passage first commits its highlight; an existing one shares as it is.
    const shareAction = { ...(sharePiece !== null
      ? command("SharePiece", "share piece", <Share2 size={16} aria-hidden="true" />, ({ triggerEl }) => sharePiece(triggerEl), blockedReason)
      : command(draft.highlightId ? "ShareHighlight" : "SharePassage", draft.highlightId ? "share highlight" : "share passage", <Share2 size={16} aria-hidden="true" />,
        ({ triggerEl }) => verbs.share(triggerEl), draft.highlightId ? null : blockedReason)), hasPopup: "dialog" as const };
    const options: ActionDescriptor[] = isMobile ? [copyAction] : [];
    if (isMobile) {
      options.push({ kind: "custom", id: "HighlightColours", label: "highlight colours", render: ({ closeMenu }) =>
        <Colours selected={annotation?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={blockedReason} size="comfortable"
          onSelect={(color) => { closeMenu(); verbs.highlight(color); }} /> });
      if (canQuote) {
        if (selected) options.push({ ...existingAction, label: `${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""}` });
        options.push(chooseAction);
      }
      options.push(shareAction);
    }
    if (draft.highlightId) {
      const id = draft.highlightId;
      if (annotation?.placement.kind === "placed") options.push(command("EditHighlightBounds", "edit highlight bounds", <Move size={16} aria-hidden="true" />, () => verbs.editBounds(id), blockedReason));
      options.push({ ...command("DeleteHighlight", "delete highlight", <Trash2 size={16} aria-hidden="true" />, () => verbs.remove(id), draft.operation ? "finish the current request first." : null), tone: "danger" });
    }
    const source: MenuSource = { kind: "Immediate", subjectKey: JSON.stringify([draft.id, opening.id, draft.highlightId]), title: "passage actions",
      content: { sections: [{ id: "Passage", label: null, options }] } };
    const toolbar = <div className={styles.dock} data-selection-composer={opening.id} data-mobile={isMobile}>
      {isMobile ? <HighlightButton selected={annotation?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={blockedReason} busy={draft.operation?.kind === "Highlight"} onClick={() => verbs.highlight(annotation?.color ?? "yellow")} />
        : <HighlightColourPicker key={opening.id} selected={annotation?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={blockedReason} busy={draft.operation?.kind === "Highlight"} onSelect={verbs.highlight} />}
      <SelectionAction action={saveAction} help={`${saveAction.label} · enter saves · shift-enter inserts a line`} busy={draft.operation?.kind === "Save" || draft.operation?.kind === "Ensure"} />
      {canQuote ? <>
        <SelectionAction action={newAction} help={`${newLabel} · ${shortcut}-enter`} busy={sending || preparing} />
        {!isMobile ? <div className={styles.highlightControl}>
          <SelectionAction action={existingAction} help={`${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""} · ${shortcut}-shift-enter`} busy={sending || preparing} />
          <Button ref={destinationTrigger} iconOnly className={styles.selectionIcon} aria-label="choose existing chat" aria-haspopup="dialog"
            aria-expanded={composer.pickerOpen} aria-controls={composer.pickerOpen ? pickerId : undefined}
            aria-disabled={chooseAction.disabled || undefined} tooltip={{ text: chooseAction.disabledReason ? `choose existing chat. ${chooseAction.disabledReason}` : "choose existing chat" }}
            icon={<ChevronDown size={16} aria-hidden="true" />} onClick={composer.chooseChat} />
        </div> : null}
      </> : null}
      {!isMobile ? <>
        <SelectionAction action={copyAction} help={copyAction.label} busy={false} buttonRef={copyTrigger} />
        <SelectionShare action={shareAction} help={shareAction.label} busy={sharePiece === null && draft.operation?.kind === "Ensure"}
          returnFocus={() => copyTrigger.current ?? returnFocus()} />
      </> : null}
      {options.length > 0 ? <ActionMenu source={source} label="more passage actions" className={styles.selectionIcon} triggerRef={(node) => { moreTrigger.current = node; }} /> : null}
    </div>;
    if (headerOnly) return toolbar;
    return (
      <div data-mobile={isMobile} className={styles.selectionComposer}>
        {!isMobile ? toolbar : null}
        {unavailable || sourceChanged ? <FeedbackNotice content={{ tone: "Warning", title: "the passage changed", message: "select it again before saving or sending." }} announcement="Polite"
          actions={[{ label: "select passage again", onClick: composer.reselect }, { label: "copy text", onClick: () => copy(feedback, draft.body.body_text, "text couldn’t be copied") }]} /> : null}
        {annotation && annotation.placement.kind !== "placed" ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY[annotation.placement.kind] }} announcement="None" /> : null}
        {annotation ? <AttachedNotes annotation={annotation} /> : null}
        <div data-selection-composer={opening.id} className={styles.selectionInput} onCompositionStartCapture={composer.compositionStart}
          onChangeCapture={composer.compositionStart} onPasteCapture={composer.compositionStart} onDropCapture={composer.compositionStart}>
          <PaneReturnVisitScope visitId={visitScope.visitId} routeKey={visitScope.routeKey}>
            <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`} containingNoteRef={null}
              body={draft.body} revision={draft.revision} label={isMobile ? opening.mode === "Ask" ? "question about passage" : "note on passage" : "note or question"}
              reference={composer.reference()} placeholder={isMobile ? opening.mode === "Ask" ? "ask about this passage" : annotation?.notes.length ? "add another note…" : "write a note…" : "note or question…"} compact editable
              focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
              onEdit={composer.edit} onSelectionChange={composer.selection} onAttachmentActiveChange={composer.attachmentActive}
              history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
              onSave={composer.save} onNewChat={canQuote ? () => composer.newChat("default") : undefined}
              onContinueChat={canQuote ? () => composer.continueChat() : undefined}
            />
          </PaneReturnVisitScope>
        </div>
        {failed ? <FeedbackNotice content={{ tone: "Danger", title: "couldn’t save on this device", message: "keep this page open. retry saving." }} announcement="Assertive"
          actions={[{ label: "retry", onClick: failed.retry }, { label: "copy text", onClick: () => copy(feedback, draft.body.body_text, "text couldn’t be copied") }]} /> : null}
        {canQuote ? <>
          {commandRecovery ? <FeedbackNotice content={{ tone: "Warning", title: commandRecovery.kind === "Unconfirmed" ? "highlight saved; send not confirmed" : "this chat changed", message: commandRecovery.kind === "Unconfirmed" ? "the request may have succeeded." : "review this chat before sending again." }} announcement="Polite"
            actions={commandRecovery.kind === "Unconfirmed" ? [{ label: "retry same send", onClick: composer.retryChat }]
              : [{ label: "refresh chat", onClick: composer.refreshChat }]} />
            : chatIssue ? <FeedbackNotice content={{ tone: "Warning", title: chatIssue.highlightSaved ? "highlight saved; question not sent" : chatIssue.message, message: chatIssue.highlightSaved ? chatIssue.message : undefined }} announcement="Polite"
              actions={chatIssue.kind === "Catalog" ? [
                { label: "retry", onClick: composer.retryCatalog },
                { label: "choose a model in chat", onClick: composer.recoverModel },
              ] : chatIssue.kind === "Passage" || chatIssue.kind === "Source" ? [
                { label: "select passage again", onClick: composer.reselect },
                { label: "copy text", onClick: () => copy(feedback, draft.body.body_text, "text couldn’t be copied") },
              ] : chatIssue.kind === "Model" ? [{ label: "choose a model in chat", onClick: composer.recoverModel }]
                : chatIssue.kind === "Missing" ? [{ label: "choose existing chat…", onClick: composer.chooseChat }]
                : chatIssue.kind === "Changed" ? [{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }] : undefined} />
              : composer.chatLocked && !composer.ownChatCommand ? <FeedbackNotice content={{ tone: "Neutral", title: "another chat change is still in progress" }} announcement="Polite"
                actions={selected ? [{ label: "open chat", onClick: composer.openChat }] : undefined} />
                : blockedChat ? <FeedbackNotice content={{ tone: "Neutral", title: blockedChat }} announcement="Polite"
                  actions={[{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }]} />
                  : destination.kind === "LookupFailed" ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t find a recent chat" }} announcement="Polite"
                      actions={[{ label: "retry", onClick: composer.retryDefault }]} /> : null}
        </> : null}
      </div>
    );
  };
  const recolouring = verbs.recolouring ? store.annotation(verbs.recolouring) : null;
  return <>
    {isMobile ? <MobileSelectionActions verbs={verbs} reader={reader} canQuote={canQuote} sharePiece={sharePiece} /> : null}
    {isMobile ? <MobileSheet active={draft !== null && opening !== null}
      ariaLabel={opening?.mode === "Ask" ? "ask about passage" : "note on passage"}
      heightLimit="available" onDismiss={composer.dismiss} focusKey={opening?.id}
      handleLabel="close passage editor" renderHeader={() => renderComposer(true, false, true)}
      initialFocus={(panel) => opening?.focus ? panel.querySelector<HTMLElement>('[data-selection-composer] [role="textbox"][contenteditable="true"]') ?? panel : panel}
      returnFocusTo={() => { const element = returnFocus(); return element ? { element, preventScroll: true } : null; }}>
      {renderComposer(true, false)}
    </MobileSheet> : draft && opening ? <FloatingActionSurface open anchor={anchor} subscribeAnchor={reader.subscribe}
      strategy="text-selection" role="group" label="passage annotation" className={styles.composerSurface}
      onDismiss={composer.dismiss}>
      {(placed, anchorState) => renderComposer(placed, anchorState === "unavailable")}
    </FloatingActionSurface> : null}
    {menu ? <FloatingActionSurface open anchor={chooserAnchor} subscribeAnchor={reader.subscribe} role="group" label="choose highlight" onDismiss={verbs.closeMenu}>
      <div className={styles.chooser}>
        <span>choose highlight</span>
        {menu.marks.map((mark) => {
          const own = store.annotation(mark.id);
          return <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
            {own ? own.selection.quote_exact : "highlight"}
            <span>{mark.color} · {own ? `your highlight${own.notes.length ? ` · ${own.notes.length === 1 ? "1 note" : `${own.notes.length} notes`}` : ""}` : "shared highlight"}</span>
          </button>;
        })}
      </div>
    </FloatingActionSurface> : null}
    <Dialog open={verbs.recolouring !== null} title="edit highlight" onClose={() => verbs.recolour(null)}>
      <Colours selected={recolouring?.color ?? null} onSelect={verbs.recolour} />
    </Dialog>
    {draft ? <ConversationDestinationOverlay key={draft.id} anchor={pickerAnchor} panelId={pickerId} open={composer.pickerOpen} mediaId={draft.sourceMediaId} hasSourceChats={draft.sourceHasChats}
      onClose={composer.closePicker} onSelectConversation={composer.chooseDestination} /> : null}
  </>;
}
