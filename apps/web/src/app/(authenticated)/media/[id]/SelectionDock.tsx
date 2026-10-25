"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from "react";
import { ChevronDown, Copy, MessageCircle, MessagesSquare, Save, Share2, Trash2 } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import { TextComparison, copyWriting } from "@/components/notes/NoteNotices";
import ResourceBody from "@/components/resources/ResourceBody";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import { PaneReturnVisitScope, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { prepareActionSelect, type ActionDescriptor, type ActionSelectDetail, type MenuContent, type MenuSource } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs, MobileSelection } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours, HighlightButton } from "./HighlightColourPicker";
import { canRetryWriting } from "@/lib/notes/writes";
import { convertReaderQuestion } from "@/lib/chat/readerQuestion";
import { isEmptyParagraph } from "./selectionDrafts";
import styles from "./media.module.css";

const COMPOSER_ACTIONS = new Set(["Chat", "HighlightNote", "EditHighlight"]);

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

/** The native invoker survives ensure and fact loading; only capability absence removes it. */
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
function MobileSelectionActions({ verbs, reader, store, canQuote, sharePiece }: {
  readonly verbs: AnnotationVerbs;
  readonly reader: Reader;
  readonly store: AnnotationStore;
  readonly canQuote: boolean;
  readonly sharePiece: ((trigger: HTMLElement | null) => void) | null;
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
          void copyText(captured.capture.quote).catch(() => feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: "reader-copy-passage", announcement: "Polite",
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
      options.push(...state.options.filter((action) => !COMPOSER_ACTIONS.has(action.id) && !(sharePiece !== null && action.id === "Share")).map((action) => {
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
    } else if (!captured.highlightId && sharePiece === null) options.push(
      { kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
        disabled: authoringReason !== null, disabledReason: authoringReason ?? undefined, onSelect: ({ triggerEl }) => { menuCommand.current = captured; verbs.shareSelection(captured, triggerEl); } },
    );
    if (sharePiece !== null) options.push({
      kind: "command", id: "SharePiece", label: "share piece", icon: <Share2 size={16} aria-hidden="true" />,
      disabled: authoringReason !== null, disabledReason: authoringReason ?? undefined,
      onSelect: ({ triggerEl }) => {
        if (!verbs.selectionCurrent(captured)) return;
        menuCommand.current = captured;
        sharePiece(triggerEl);
      },
    });
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

export default function SelectionDock({ verbs, store, reader, isMobile, canQuote, returnFocus, sharePiece }: {
  readonly verbs: AnnotationVerbs;
  readonly store: AnnotationStore;
  readonly reader: Reader;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
  readonly returnFocus: () => HTMLElement | null;
  readonly sharePiece: ((trigger: HTMLElement | null) => void) | null;
}) {
  const { composer, menu } = verbs;
  const visitScope = usePaneVisitWorkScope();
  const feedback = useFeedback();
  const { draft, opening } = composer;
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const copyTrigger = useRef<HTMLButtonElement | null>(null);
  const destinationTrigger = useRef<HTMLButtonElement | null>(null);
  const pickerId = useId();
  const pickerAnchor = useCallback(() => isMobile ? moreTrigger.current : destinationTrigger.current, [isMobile]);
  const { state: resourceState, prepare } = useResourceActions(draft?.highlightId ? `highlight:${draft.highlightId}` : null);
  const [actionAttempt, setActionAttempt] = useState(0);
  useEffect(() => {
    if (!draft?.highlightId) return;
    const controller = new AbortController();
    prepare(controller.signal);
    return () => controller.abort();
  }, [draft?.highlightId, prepare, actionAttempt]);
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
  const deleting = draft?.operation?.kind === "Delete";
  const emptyExisting = draft?.base.kind === "Present" && isEmptyParagraph(draft.body);
  const highlight = draft?.highlight ?? (draft?.highlightId ? store.highlight(draft.highlightId) : null);
  const map = store.getState().map;
  const overlapItems = menu && map.status !== "loading" && map.data
    ? map.data.evidence.roots.map((root) => root.content) : [];
  const renderComposer = (placed: boolean, unavailable: boolean, headerOnly = false) => {
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
    const chatLabel = selected ? `${hasMessage ? "send to" : "open in"} “${selected.title}”` : "choose existing chat";
    const chatIssue = draft.chatIssue;
    const commandRecovery = composer.ownChatCommand && (composer.chatState.kind === "Unconfirmed" || composer.chatState.kind === "RefreshRequired") ? composer.chatState : null;
    const blockedChat = composer.chat?.target.kind === "Blocked" ? composer.chat.target.reason === "AssistantRunning"
      ? "this chat is still responding" : "this chat can’t accept a reply here"
      : selected?.snapshot.kind === "RefreshRequired" ? "this chat changed"
      : selected?.snapshot.kind === "Failed" ? "couldn’t load chat" : null;
    const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "cmd" : "ctrl";
    const command = (id: string, label: string, icon: ActionDescriptor["icon"], onSelect: (detail: ActionSelectDetail) => void, reason: string | null): Extract<ActionDescriptor, { kind: "command" }> => ({
      kind: "command", id, label, icon, onSelect, disabled: reason !== null, disabledReason: reason ?? undefined,
    });
    const saveAction = command("SavePassageNote", draft.base.kind === "Absent" && isEmptyParagraph(draft.body) ? "save highlight" : "save note",
      <Save size={16} aria-hidden="true" />, composer.save, blockedReason);
    const newLabel = hasMessage ? "send in new chat" : "open in new chat";
    const chatReason = blockedReason ?? ((hasMessage ? composer.chatLocked : composer.readerChatLocked) ? "another chat change is still in progress." : null);
    const existingReason = chatReason ?? (preparing || destination.kind === "Resolving" ? "loading chat…" : continuationBlocked ? "this chat is not ready for this action." : null);
    const newAction = command("NewChat", newLabel, <MessageCircle size={16} aria-hidden="true" />, ({ openIntent }) => composer.newChat(openIntent), chatReason);
    const existingAction = command("ExistingChat", chatLabel, <MessagesSquare size={16} aria-hidden="true" />, ({ openIntent }) => composer.continueChat(openIntent), existingReason);
    const chooseAction = { ...command("ChooseChat", "choose existing chat", <ChevronDown size={16} aria-hidden="true" />, composer.chooseChat,
      blockedReason ?? (composer.chatLocked ? "another chat change is still in progress." : null)), restoreFocusOnClose: false };
    const copyReason = draft.passage.quote.trim().length > 0 ? null : {
      Loading: "loading passage text…",
      Failed: "passage text couldn’t be loaded",
      Ready: "this highlight has no text to copy",
    }[draft.load];
    const copyAction = command("CopyPassage", "copy passage", <Copy size={16} aria-hidden="true" />, () => {
      void copyText(draft.passage.quote).catch(() => feedback.offer({ needsAttention: true, undo: null, onDismiss: null, key: "reader-copy-passage", announcement: "Polite",
        content: { tone: "Danger", title: "passage couldn’t be copied" } }));
    }, copyReason);
    const shareAction = sharePiece !== null
      ? { ...command("SharePiece", "share piece", <Share2 size={16} aria-hidden="true" />, ({ triggerEl }) => sharePiece(triggerEl), blockedReason), hasPopup: "dialog" as const }
      : !draft.highlightId
        ? { ...command("SharePassage", "share passage", <Share2 size={16} aria-hidden="true" />, ({ triggerEl }) => verbs.share(triggerEl), blockedReason), hasPopup: "dialog" as const }
        : resourceState?.kind === "Ready"
          ? resourceState.options.find((action): action is Extract<ActionDescriptor, { kind: "command" }> => action.kind === "command" && action.id === "Share") ?? null
          : null;
    const sharePending = sharePiece === null && draft.highlightId !== null && resourceState?.kind !== "Ready";
    const sharePresentation: SelectionActionPresentation | null = shareAction ? { action: shareAction }
      : sharePending ? { action: null, unavailable: {
        id: "Share", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
        reason: resourceState?.kind === "Failed" ? "open more to retry highlight actions" : "loading highlight actions…",
        hasPopup: "dialog",
      } } : null;
    const options: ActionDescriptor[] = isMobile ? [copyAction] : [];
    if (isMobile) {
      options.push({ kind: "custom", id: "HighlightColours", label: "highlight colours", render: ({ closeMenu }) =>
        <Colours selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={highlightReason} size="comfortable"
          onSelect={(color) => { closeMenu(); verbs.highlight(color); }} /> });
      if (canQuote) {
        if (selected) options.push({ ...existingAction, label: `${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""}` });
        options.push(chooseAction);
      }
    }
    if (draft.highlightId) {
      if (resourceState?.kind === "Ready") options.push(...resourceState.options.filter((action) => !COMPOSER_ACTIONS.has(action.id) && !((sharePiece !== null || !isMobile) && action.id === "Share")).map((action) =>
        action.kind === "command" && (action.id === "DeleteHighlight" || action.id === "EditHighlightBounds")
          ? { ...action, disabled: action.disabled || blockedReason !== null, disabledReason: action.disabledReason ?? blockedReason ?? undefined } : action));
      else {
        options.push({ kind: "custom", id: "HighlightActionsFeedback", label: "highlight actions", render: () => resourceState?.kind === "Failed"
          ? <FeedbackNotice content={resourceState.feedback} announcement="Polite" />
          : <FeedbackStatus content={{ tone: "Neutral", title: "loading highlight actions…" }} announcement="Polite" /> });
        if (resourceState?.kind === "Failed") options.push(command("RetryHighlightActions", "retry highlight actions", undefined, () => setActionAttempt((value) => value + 1), null));
      }
    }
    if (isMobile && shareAction && (!draft.highlightId || sharePiece !== null)) options.push(shareAction);
    if (emptyExisting) options.push({ ...command("DeleteEmptyNote", "delete empty note (keep highlight)", <Trash2 size={16} aria-hidden="true" />, composer.deleteNote, blockedReason), tone: "danger" });
    const source: MenuSource = { kind: "Immediate", subjectKey: JSON.stringify([draft.id, opening.id, draft.highlightId]), title: "passage actions",
      content: { sections: [{ id: "Passage", label: null, options }] } };
    const toolbar = <div className={styles.dock} data-selection-composer={opening.id} data-mobile={isMobile}>
      {isMobile ? <HighlightButton selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={highlightReason} busy={draft.operation?.kind === "Highlight"} onSelect={verbs.highlight} />
        : <HighlightColourPicker key={opening.id} selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={highlightReason} busy={draft.operation?.kind === "Highlight"} onSelect={verbs.highlight} />}
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
        {sharePresentation ? <SelectionShare {...sharePresentation} help={shareAction?.label ?? "share passage"}
          busy={sharePiece === null && (draft.operation?.kind === "Ensure" || sharePending && resourceState?.kind !== "Failed")}
          returnFocus={() => copyTrigger.current ?? returnFocus()} /> : null}
      </> : null}
      {options.length > 0 ? <ActionMenu source={source} label="more passage actions" className={styles.selectionIcon} triggerRef={(node) => { moreTrigger.current = node; }} /> : null}
    </div>;
    if (headerOnly) return toolbar;
    return (
      <div data-mobile={isMobile} className={styles.selectionComposer}>
        {!isMobile ? toolbar : null}
        {unavailable || sourceChanged ? <FeedbackNotice content={{ tone: "Warning", title: "the passage changed", message: "select it again before saving or sending." }} announcement="Polite"
          actions={[{ label: "select passage again", onClick: composer.reselect }, { label: "copy text", onClick: () => copyWriting(feedback, draft.body.body_text) }]} /> : null}
        <div data-selection-composer={opening.id} className={styles.selectionInput} onCompositionStartCapture={composer.compositionStart}
          onChangeCapture={composer.compositionStart} onPasteCapture={composer.compositionStart} onDropCapture={composer.compositionStart}>
          <PaneReturnVisitScope visitId={visitScope.visitId} routeKey={visitScope.routeKey}>
          {draft.load === "Ready" ? <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`}
            containingNoteRef={draft.base.kind === "Present" ? `note_block:${draft.base.id}` : null}
            body={draft.body} embeddedItem={draft.base.kind === "Present" ? draft.base.embeddedItem : null} revision={draft.revision} label={isMobile ? opening.mode === "Ask" ? "question about passage" : "note on passage" : "note or question"}
            reference={composer.reference()} placeholder={isMobile ? opening.mode === "Ask" ? "ask about this passage" : "write a note…" : "note or question…"} compact editable={!deleting && !composer.paused}
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
            : null}
      </div>
    );
  };
  return <>
    {isMobile ? <MobileSelectionActions verbs={verbs} reader={reader} store={store} canQuote={canQuote} sharePiece={sharePiece} /> : null}
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
    {draft ? <ConversationDestinationOverlay key={draft.id} anchor={pickerAnchor} panelId={pickerId} open={composer.pickerOpen} mediaId={draft.sourceMediaId} hasSourceChats={draft.sourceHasChats}
      onClose={composer.closePicker} onSelectConversation={composer.chooseDestination} /> : null}
  </>;
}
