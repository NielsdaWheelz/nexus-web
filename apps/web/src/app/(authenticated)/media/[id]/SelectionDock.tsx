"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Copy, Save, Share2 } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import { TextComparison, copyWriting } from "@/components/notes/NoteNotices";
import ResourceBody from "@/components/resources/ResourceBody";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import { PaneReturnVisitScope, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { prepareActionSelect, projectActionControlState, type ActionDescriptor, type ActionSelectDetail, type MenuContent, type MenuSource } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs, MobileSelection } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours } from "./HighlightColourPicker";
import { canRetryWriting } from "@/lib/notes/writes";
import { convertReaderQuestion } from "@/lib/chat/readerQuestion";
import { isEmptyParagraph } from "./selectionDrafts";
import styles from "./media.module.css";

const COMPOSER_ACTIONS = new Set(["Chat", "HighlightNote", "EditHighlight"]);

/** One local projection preserves command state, native navigation and unavailable help. */
function SelectionAction({ action, blockedReason = null }: {
  readonly action: Exclude<ActionDescriptor, { kind: "custom" }>;
  readonly blockedReason?: string | null;
}) {
  const reasonId = useId();
  const runtime = usePaneRuntime();
  if (!action.icon) throw new Error(`Selection action ${action.id} has no icon`);
  const control = projectActionControlState(action.label, action.kind === "command" ? action.state : undefined);
  const reason = blockedReason ?? (action.disabled ? action.disabledReason ?? "this action is unavailable." : null);
  const description = control.menuLabel;
  // A blocked control stops activation before this runs.
  const activate = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement> | KeyboardEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (action.kind === "link") {
      if (action.onActivate) action.onActivate(event);
      else activateTargetLink({ event, runtime, target: { href: action.href } });
      return;
    }
    const detail = prepareActionSelect(event, event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (detail) action.onSelect(detail);
  };
  const tone = action.tone === "danger" ? "danger" : undefined;
  const icon = <>
    {action.icon}
    {action.indicator ? <span className={styles.selectionStatusMarker} /> : null}
  </>;
  const tooltip = { text: reason ? `${description}. ${reason}` : description };
  return <>
    {action.kind === "link" ? (
      <ButtonLink href={action.href} aria-disabled={reason !== null || undefined} iconOnly icon={icon} tone={tone}
        className={styles.selectionIcon} tooltip={tooltip} aria-label={action.label}
        aria-describedby={reason ? reasonId : undefined} data-action-id={action.id}
        data-workspace-rich-target="true" onClick={activate} onKeyDown={activate} />
    ) : (
      <Button aria-disabled={reason !== null || undefined} iconOnly icon={icon} tone={tone}
        className={styles.selectionIcon} tooltip={tooltip} aria-label={action.label}
        aria-describedby={reason ? reasonId : undefined} data-action-id={action.id}
        aria-pressed={control.barPressed} aria-expanded={control.barExpanded} aria-controls={control.barControls}
        onClick={activate} onKeyDown={activate} />
    )}
    {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
  </>;
}

/** The canonical action model, rendered directly; this surface has no menu to close. */
function HighlightActions({ id, blockedReason }: { readonly id: string; readonly blockedReason: string | null }) {
  const { state, prepare } = useResourceActions(`highlight:${id}`);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    prepare(controller.signal);
    return () => controller.abort();
  }, [prepare, attempt]);
  if (state === null || state.kind === "Loading") return <FeedbackStatus
    content={{ tone: "Neutral", title: "loading actions…" }} announcement="Polite" />;
  if (state.kind === "Failed") return <FeedbackNotice content={state.feedback} announcement="Polite"
    actions={[{ label: "retry", onClick: () => setAttempt((current) => current + 1) }]} />;
  return <>
    {state.options.filter((action) => !COMPOSER_ACTIONS.has(action.id)).map((action) => {
      if (action.kind === "custom") return <div key={action.id}>{action.render({ triggerEl: null, closeMenu: () => {}, closeMenuWithoutFocus: () => {}, presentation: "bar" })}</div>;
      return <SelectionAction key={action.id} action={action} blockedReason={blockedReason} />;
    })}
  </>;
}

/** A press freezes one source capture; only its native click may execute it. */
function MobileSelectionActions({ verbs, reader, store, canQuote }: {
  readonly verbs: AnnotationVerbs;
  readonly reader: Reader;
  readonly store: AnnotationStore;
  readonly canQuote: boolean;
}) {
  const feedback = useFeedback();
  const authoringReason = verbs.composer.paused ? "writing is paused." : null;
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
  const { state, prepare } = useResourceActions(subject?.highlightId ? `highlight:${subject.highlightId}` : null);
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
    const highlight = captured.highlightId ? store.highlight(captured.highlightId) : null;
    const options: ActionDescriptor[] = [
      { kind: "command", id: "CopyPassage", label: "copy passage", icon: <Copy size={16} aria-hidden="true" />,
        onSelect: () => {
          if (!verbs.selectionCurrent(captured)) return;
          void copyText(captured.capture.quote).catch(() => feedback.offer({ key: "reader-copy-passage", announcement: "Polite",
            content: { tone: "Danger", title: "passage couldn’t be copied" } }));
        } },
      { kind: "custom", id: "HighlightColours", label: "highlight colour", render: ({ closeMenu }) => (
        <Colours selected={highlight?.color ?? "yellow"} persisted={captured.highlightId !== null} disabledReason={authoringReason} size="comfortable"
          onSelect={(color) => { closeMenu(); menuCommand.current = captured; verbs.highlightSelection(captured, color); }} />
      ) },
    ];
    if (captured.highlightId && state?.kind === "Ready") {
      const guard = (event: MouseEvent | KeyboardEvent) => {
        if (!verbs.selectionCurrent(captured)) { event.preventDefault(); event.stopPropagation(); }
      };
      options.push(...state.options.filter((action) => !COMPOSER_ACTIONS.has(action.id)).map((action) => {
        if (action.kind === "command") return { ...action,
          onSelect: (detail: ActionSelectDetail) => { if (verbs.selectionCurrent(captured)) action.onSelect(detail); } };
        if (action.kind === "link") {
          const onActivate: NonNullable<typeof action.onActivate> = (event) => {
            if (!verbs.selectionCurrent(captured)) { event.preventDefault(); return "consumed"; }
            return action.onActivate?.(event) ?? "unhandled";
          };
          return { ...action, onActivate };
        }
        return { ...action, render: (controls) => <div onClickCapture={guard} onKeyDownCapture={guard}>
          {action.render(controls)}
        </div> } satisfies ActionDescriptor;
      }));
    } else if (!captured.highlightId) options.push(
      { kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
        disabled: authoringReason !== null, disabledReason: authoringReason ?? undefined, onSelect: ({ triggerEl }) => { menuCommand.current = captured; verbs.shareSelection(captured, triggerEl); } },
    );
    return { sections: [{ id: "Passage", label: null, options }] };
  };
  const source: MenuSource = {
    subjectKey: subject ? JSON.stringify([subject.id, subject.capture]) : ownerId,
    title: "passage actions",
    ...(subject?.highlightId ? { kind: "Prepared" as const, prepare,
      state: state?.kind === "Ready" ? { kind: "Ready" as const, request: state.request, content: content(subject) } : state }
      : { kind: "Immediate" as const, content: subject ? content(subject) : { sections: [] } }),
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
        const live = reader.captureSelection();
        current.current.cancelSelectionActivation();
        if (live?.kind !== "Captured") reader.focusSource();
      });
    }}
    renderTrigger={(trigger) => (
      <FloatingActionSurface open={verbs.selectionVisible && subject !== null} anchor={anchor} subscribeAnchor={reader.subscribe}
        strategy="mobile-selection-actions" selectionSession={subject?.id ?? null}
        role="group" label={confirming ? "confirm passage selection" : "passage actions"} onDismiss={verbs.dismissSelection}>
        <div ref={row} className={styles.mobileSelectionActions}>
          {confirming ? <>
            <Button size="comfortable" emphasis="strong" disabled={authoringReason !== null}
              tooltip={authoringReason ? { text: authoringReason } : undefined} onPointerDown={pointerDown} onKeyDown={keyDown}
              onFocus={(event) => focusControl(event.currentTarget)} onClick={(event) => activate(event, verbs.applySelection)}>apply selection</Button>
            <Button size="comfortable" onClick={verbs.bounds ? verbs.cancelBounds : verbs.dismissSelection}>cancel</Button>
          </> : <>
            <Button size="comfortable" disabled={Boolean(subject?.highlightId) || authoringReason !== null}
              tooltip={authoringReason ? { text: authoringReason } : undefined}
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.highlightSelection(captured, "yellow"))}>
              {subject?.highlightId ? "highlighted" : "highlight"}
            </Button>
            <Button size="comfortable" disabled={authoringReason !== null} tooltip={authoringReason ? { text: authoringReason } : undefined}
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.composeSelection(captured, "Note"))}>note</Button>
            {canQuote ? <Button size="comfortable" disabled={authoringReason !== null} tooltip={authoringReason ? { text: authoringReason } : undefined}
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.composeSelection(captured, "Ask"))}>ask</Button> : null}
            <Button {...trigger} size="comfortable" onPointerDown={pointerDown} onKeyDown={keyDown}
              onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => { menuCommand.current = null; setMenuSubject(captured); trigger.onClick(event); })}>more</Button>
          </>}
        </div>
      </FloatingActionSurface>
    )} />;
}

export default function SelectionDock({ verbs, store, reader, isMobile, canQuote, returnFocus }: {
  readonly verbs: AnnotationVerbs;
  readonly store: AnnotationStore;
  readonly reader: Reader;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const { composer, menu } = verbs;
  const visitScope = usePaneVisitWorkScope();
  const feedback = useFeedback();
  const { draft, opening } = composer;
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const sourceChanged = draft?.issue?.kind === "Source" || (draft !== null && identity !== null && draft.passage.identity !== identity);
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
  const blocked = composer.paused || !draft || draft.load !== "Ready" || draft.operation !== null || draft.referenceActive || draft.attachmentActive;
  const deleting = draft?.operation?.kind === "Delete";
  const emptyExisting = draft?.base.kind === "Present" && isEmptyParagraph(draft.body);
  const highlight = draft?.highlight ?? (draft?.highlightId ? store.highlight(draft.highlightId) : null);
  const map = store.getState().map;
  const overlapItems = menu && map.status !== "loading" && map.data
    ? map.data.evidence.roots.map((root) => root.content) : [];
  const size = isMobile ? "comfortable" : undefined;
  const renderComposer = (placed: boolean, unavailable: boolean) => {
    if (!draft || !opening) return null;
    const blockedReason = composer.paused ? "writing is paused." : sourceChanged ? "the source changed. your words are kept; select the passage again."
      : draft.chatIssue?.kind === "Passage" || draft.chatIssue?.kind === "Source" ? "select the passage again before saving or sending."
      : draft.issue?.kind === "Conflict" || draft.issue?.kind === "Deleted" ? "review the saved note or choose a new passage before saving."
      : draft.load !== "Ready" ? "load your note before using this action."
      : draft.attachmentActive ? "finish or discard the attachment before saving or sending."
      : draft.referenceActive ? (isMobile ? "finish linking before using this action." : "finish linking or press escape to keep this as prose.")
      : draft.operation ? "finish or retry the current request first."
      : unavailable && !draft.highlightId ? "this passage is no longer available." : null;
    const highlightReason = blockedReason ?? (highlight?.is_owner === false ? "only your own highlight can be changed." : null);
    const hasMessage = convertReaderQuestion(draft.body).kind !== "Blank";
    const destination = draft.destination;
    const selected = destination.kind === "Selected" ? destination : null;
    const preparing = draft.chatAttempt?.kind === "Preparing" || draft.operation?.kind === "Chat" || draft.operation?.kind === "Ensure" || (selected?.snapshot.kind === "Loading");
    const sending = composer.ownChatCommand && composer.chatState.kind === "Busy";
    const continuationBlocked = (selected !== null && selected.snapshot.kind !== "Ready") || (hasMessage && composer.chat?.target.kind === "Blocked");
    const chatLabel = sending ? "sending…" : preparing ? "loading chat…" : destination.kind === "Resolving" ? "finding a chat…"
      : selected ? `${hasMessage ? "send to" : "open in"} “${selected.title}”` : "choose existing chat…";
    const chatIssue = draft.chatIssue;
    const commandRecovery = composer.ownChatCommand && (composer.chatState.kind === "Unconfirmed" || composer.chatState.kind === "RefreshRequired") ? composer.chatState : null;
    const blockedChat = composer.chat?.target.kind === "Blocked" ? composer.chat.target.reason === "AssistantRunning"
      ? "this chat is still responding" : "this chat can’t accept a reply here"
      : selected?.snapshot.kind === "RefreshRequired" ? "this chat changed"
      : selected?.snapshot.kind === "Failed" ? "couldn’t load chat" : null;
    return (
      <div data-selection-composer={opening.id} data-mobile={isMobile} className={styles.selectionComposer}>
        <div className={styles.passageCue}>{draft.passage.quote || "selected passage"}</div>
        {unavailable || sourceChanged ? <FeedbackNotice content={{ tone: "Warning", title: "the passage changed", message: "select it again before saving or sending." }} announcement="Polite"
          actions={[{ label: "select passage again", onClick: composer.reselect }, { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) }]} /> : null}
        <div className={styles.dock}>
          <HighlightColourPicker key={opening.id} selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null}
            disabledReason={highlightReason} onSelect={verbs.highlight} />
          <SelectionAction blockedReason={blocked ? blockedReason : null} action={{ kind: "command", id: "CopyPassage", label: "copy passage", icon: <Copy size={16} aria-hidden="true" />, onSelect: () => {
            void copyText(draft.passage.quote).catch(() => feedback.offer({ key: "reader-copy-passage", announcement: "Polite", content: { tone: "Danger", title: "passage couldn’t be copied" } }));
          } }} />
          <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SavePassageNote", label: draft.base.kind === "Absent" && isEmptyParagraph(draft.body) ? "save highlight" : "save note",
            icon: <Save size={16} aria-hidden="true" />, onSelect: composer.save }} />
          {draft.highlightId ? <HighlightActions id={draft.highlightId} blockedReason={blockedReason} /> :
            <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
              onSelect: ({ triggerEl }) => verbs.share(triggerEl) }} />}
        </div>
        <div className={styles.selectionInput} onCompositionStartCapture={composer.compositionStart}
          onChangeCapture={composer.compositionStart} onPasteCapture={composer.compositionStart} onDropCapture={composer.compositionStart}>
          <PaneReturnVisitScope visitId={visitScope.visitId} routeKey={visitScope.routeKey}>
          {draft.load === "Ready" ? <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`}
            containingNoteRef={draft.base.kind === "Present" ? `note_block:${draft.base.id}` : null}
            body={draft.body} embeddedItem={draft.base.kind === "Present" ? draft.base.embeddedItem : null} revision={draft.revision} label={isMobile ? opening.mode === "Ask" ? "question about passage" : "note on passage" : "note or question"}
            reference={composer.reference()} placeholder={isMobile && opening.mode === "Ask" ? "ask about this passage" : "write a note, or @ link something"} compact editable={!deleting && !composer.paused}
            focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
            onEdit={composer.edit} onSelectionChange={composer.selection} onAttachmentActiveChange={composer.attachmentActive}
            history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
            onSave={composer.save} onNewChat={canQuote ? () => composer.newChat("default") : undefined}
            onContinueChat={canQuote ? () => composer.continueChat() : undefined} onEmptyBackspace={composer.deleteNote}
            />
            : !draft.issue ? <FeedbackStatus content={{ tone: "Neutral", title: "loading your note…" }} announcement="Polite" /> : null}
          </PaneReturnVisitScope>
        </div>
        {canQuote ? <>
          <div className={styles.chatFooter}>
            <Button size={size} disabled={Boolean(blockedReason) || (hasMessage ? composer.chatLocked : composer.readerChatLocked)} onClick={() => composer.newChat("default")}>new chat</Button>
            <Button size={size} emphasis="strong" className={styles.destinationAction} tooltip={{ text: selected ? `${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""}` : chatLabel }}
              disabled={Boolean(blockedReason) || (hasMessage ? composer.chatLocked : composer.readerChatLocked) || preparing || destination.kind === "Resolving" || Boolean(continuationBlocked)}
              onClick={() => composer.continueChat()}><span className={styles.destinationLabel}>{chatLabel}</span></Button>
            <Button size={size} aria-expanded={composer.pickerOpen} disabled={Boolean(blockedReason) || composer.chatLocked} onClick={composer.chooseChat}>choose existing chat</Button>
          </div>
          {composer.branchCue ? <div className={styles.composerHint}>{composer.branchCue}</div> : null}
          {commandRecovery ? <FeedbackNotice content={{ tone: "Warning", title: commandRecovery.kind === "Unconfirmed" ? "highlight saved; send not confirmed" : "this chat changed", message: commandRecovery.kind === "Unconfirmed" ? "the request may have succeeded." : "review this chat before sending again." }} announcement="Polite"
            actions={commandRecovery.kind === "Unconfirmed" ? [{ label: "retry same send", onClick: composer.retryChat }]
              : [{ label: "refresh chat", onClick: composer.refreshChat }]} />
            : chatIssue ? <FeedbackNotice content={{ tone: "Warning", title: chatIssue.highlightSaved ? "highlight saved; question not sent" : chatIssue.message, message: chatIssue.highlightSaved ? chatIssue.message : undefined }} announcement="Polite"
              actions={chatIssue.kind === "Catalog" ? [
                { label: "retry", onClick: composer.retryCatalog },
                { label: "choose a model in chat", onClick: composer.recoverModel },
              ] : chatIssue.kind === "Passage" || chatIssue.kind === "Source" ? [
                { label: "select passage again", onClick: composer.reselect },
                { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) },
              ] : chatIssue.kind === "Model" ? [{ label: "choose a model in chat", onClick: composer.recoverModel }]
                : chatIssue.kind === "Missing" ? [{ label: "choose existing chat…", onClick: composer.chooseChat }]
                : chatIssue.kind === "Changed" ? [{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }] : undefined} />
              : composer.chatLocked && !composer.ownChatCommand ? <FeedbackNotice content={{ tone: "Neutral", title: "another chat change is still in progress" }} announcement="Polite"
                actions={selected ? [{ label: "open chat", onClick: composer.openChat }] : undefined} />
                : blockedChat ? <FeedbackNotice content={{ tone: "Neutral", title: blockedChat }} announcement="Polite"
                  actions={[{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }]} />
                  : destination.kind === "Absent" ? <FeedbackStatus content={{ tone: "Neutral", title: "no chat for this source yet" }} announcement="Polite" />
                    : destination.kind === "LookupFailed" ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t find a recent chat" }} announcement="Polite"
                      actions={[{ label: "retry", onClick: composer.retryDefault }]} /> : null}
        </> : null}
        {draft.issue?.kind === "Conflict" && draft.issue.saved.kind === "Present" ? <TextComparison
          value={draft.body} saved={draft.issue.saved.body} before={draft.base.kind === "Present" ? draft.base.body : null}
          shown={composer.conflictShown} resolve={(choice, shown) => composer.resolveConflict(choice === "saved", shown)} />
          : draft.issue && draft.issue.kind !== "Source" ? <FeedbackNotice content={{ tone: "Warning", title: draft.issue.message }} announcement="Polite"
            actions={draft.write?.read().kind === "unconfirmed" ? (() => {
              const state = draft.write.read();
              return state.kind === "unconfirmed" && !canRetryWriting(draft.write) ? [
                { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) },
                { label: "reload", onClick: () => { window.location.reload(); } },
              ] : [{ label: "retry same save", onClick: composer.retry },
                { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) }];
            })() : draft.issue.kind === "Conflict" ? [
              { label: "use saved version", onClick: () => void composer.resolveConflict(true, composer.conflictShown) },
              { label: "replace saved version", onClick: () => void composer.resolveConflict(false, composer.conflictShown) },
            ] : draft.load === "Failed" ? [{ label: "reload note", onClick: composer.retry },
              { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) }]
              : [{ label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) }]} />
            : draft.status ? <FeedbackStatus content={{ tone: "Neutral", title: draft.status }} announcement="None" /> : null}
        {!isMobile ? <div className={styles.composerHint}>{draft.referenceActive ? "enter links · escape keeps literal text" : <>enter saves · shift+enter new line · {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "ctrl"}+enter {hasMessage ? "sends in new chat" : "opens a new chat"} · modifier+shift+enter {selected ? "uses the displayed chat" : "chooses existing chat"}</>}</div> : null}
        {emptyExisting ? <div className={styles.composerHint}>
          {isMobile ? "the highlight stays." : "backspace deletes this note and its links. the highlight stays."}
          <Button size={size} tone="danger" disabled={blocked} onClick={composer.deleteNote}>delete empty note</Button>
        </div> : null}
      </div>
    );
  };
  return <>
    {isMobile ? <MobileSelectionActions verbs={verbs} reader={reader} store={store} canQuote={canQuote} /> : null}
    {isMobile ? <MobileSheet active={draft !== null && opening !== null}
      ariaLabel={opening?.mode === "Ask" ? "ask about passage" : "note on passage"}
      heightLimit="available" onDismiss={composer.dismiss} focusKey={opening?.id}
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
          const highlight = store.highlight(mark.id);
          const item = overlapItems.find((item): item is Schema<"ReaderEvidenceHighlightOut"> => item.kind === "Highlight" && item.highlight_id === mark.id);
          return <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
            {item ? <ResourceBody body={item.item.preview.body} /> : "highlight"}
            <span>{mark.color} · {highlight?.is_owner ? "your highlight" : "shared highlight"}</span>
          </button>;
        })}
      </div>
    </FloatingActionSurface> : null}
    <Dialog open={verbs.recolouring !== null} title="edit highlight" onClose={() => verbs.recolour(null)}>
      <Colours selected={verbs.recolouring ? store.getState().decorations.marks.find((mark) => mark.id === verbs.recolouring)?.color ?? null : null} onSelect={verbs.recolour} />
    </Dialog>
    {draft ? <ConversationDestinationOverlay open={composer.pickerOpen} mediaId={draft.sourceMediaId} hasSourceChats={draft.sourceHasChats}
      onClose={composer.closePicker} onSelectConversation={composer.chooseDestination} /> : null}
  </>;
}
