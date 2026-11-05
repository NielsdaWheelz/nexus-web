"use client";

import { useCallback, useEffect, useId, useRef, useState, type FocusEventHandler, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from "react";
import * as Icon from "@/lib/ui/icons";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import { Field } from "@/components/feedback/Fact";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { Retract, Verb, Verbs } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import NoteEditor from "@/components/notes/NoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import { PlacementNote } from "@/lib/documentReader/chrome/ReaderAnnotation";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import { localResourceLabel } from "@/lib/resources/localResource";
import { PaneReturnVisitScope, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { prepareActionSelect, type ActionDescriptor, type MenuContent, type MenuSource } from "@/lib/ui/actionDescriptor";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { usesMeta } from "@/lib/shortcuts";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { bodyHasContent } from "@nexus/authored/body";
import type { MediaAnnotations } from "./annotations";
import type { AnnotationVerbs, MobileSelection } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours, HighlightButton } from "./HighlightColourPicker";
import { HIGHLIGHT_SAVED, SOURCE_CHANGED, type SelectionComposer } from "./useSelectionComposer";
import styles from "./media.module.css";


/** A refused clipboard says so once and offers the passage to copy by hand. */
function usePassageCopy(target: unknown) {
  const copied = useCopyFeedback(target);
  const { say } = useOutcome();
  const refusal = useRef<Retract>(() => {});
  const [manual, setManual] = useState<string | null>(null);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  useEffect(() => { refusal.current(); setManual(null); }, [target]);
  if (defect) throw defect.error;
  return {copied: copied.copied,
    copy: (text: string) => {void copied.copy(text).then(() => refusal.current(), error => {
      if (!(error instanceof ClipboardWriteUnavailableError)) return setDefect({error});
      refusal.current = say({ fact: "couldn’t copy the passage.", reason: "the clipboard isn’t available here." },
        [{ label: "show passage", commandKey: "ShowPassage", run: () => setManual(text) }]);
    });},
    notice: <>
      {copied.occurrence ? <Announcement text="copied" level="Polite" occurrence={copied.occurrence} /> : null}
      <Dialog open={manual !== null} title="copy passage" onClose={() => setManual(null)} initialFocus={panel => panel.querySelector('textarea')}>
        <textarea aria-label="passage to copy" readOnly value={manual ?? ""} onFocus={event => event.currentTarget.select()} />
      </Dialog>
    </>};
}

type SelectionActionPresentation =
  | { readonly action: Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement }; readonly unavailable?: never }
  | { readonly action: null; readonly unavailable: {
      readonly id: string; readonly label: string; readonly icon: ReactElement; readonly reason: string;
      readonly hasPopup: "dialog";
    } };

/** Primary commands share the overflow's descriptors and the common button contract. */
function SelectionAction({ action, unavailable, help, busy, buttonRef, describedBy, onBlur }: SelectionActionPresentation & {
  readonly help: string;
  readonly busy: boolean;
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
  readonly onBlur?: FocusEventHandler<HTMLButtonElement>;
  /** A field this action retries. */
  readonly describedBy?: string;
}) {
  const reasonId = useId();
  const presentation = action ?? unavailable;
  // `command` gives every disabled action its reason.
  const reason = action ? action.disabledReason ?? null : unavailable.reason;
  const activate = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (!action || action.disabled) return;
    const detail = prepareActionSelect(event, event.currentTarget);
    if (detail) action.onSelect(detail);
  };
  return <>
    <Button ref={buttonRef} aria-disabled={reason !== null || undefined} iconOnly icon={presentation.icon} className={styles.selectionIcon}
      tooltip={{ text: reason ? `${help}. ${reason}` : help }} aria-label={presentation.label}
      aria-describedby={[describedBy, reason ? reasonId : null].filter(Boolean).join(" ") || undefined} data-action-id={presentation.id} aria-busy={busy || action?.busy || undefined}
      aria-haspopup={presentation.hasPopup}
      onClick={activate} onKeyDown={activate} onBlur={onBlur} />
    {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
  </>;
}

/** a removed native invoker returns focus without replacing a newer destination. */
function RecoverableSelectionAction({ returnFocus, ...props }: SelectionActionPresentation & {
  readonly help: string;
  readonly busy: boolean;
  readonly onBlur?: FocusEventHandler<HTMLButtonElement>;
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
  const ownerId = useId();
  const row = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [menuSubject, setMenuSubject] = useState<MobileSelection | null>(null);
  const subject = menuSubject && verbs.selectionCurrent(menuSubject) ? menuSubject : verbs.mobileSelection;
  const copying = usePassageCopy(subject);
  const copy = copying.copy;
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
      { kind: "command", id: "CopyPassage", label: "Copy passage", icon: copying.copied ? <Icon.Check aria-hidden="true" /> : <Icon.Copy aria-hidden="true" />,
        onSelect: () => { if (verbs.selectionCurrent(captured)) copy(captured.capture.quote); } },
      { kind: "custom", id: "HighlightColours", label: "Highlight colour", render: ({ closeMenu }) => (
        <Colours selected={null} persisted={false} size="comfortable"
          onSelect={(color) => { closeMenu(); menuCommand.current = captured; verbs.highlightSelection(captured, color); }} />
      ) },
      sharePiece === null
        ? { kind: "command", id: "SharePassage", label: "Share passage", icon: <Icon.Share aria-hidden="true" />,
          onSelect: ({ triggerEl }) => { menuCommand.current = captured; verbs.shareSelection(captured, triggerEl); } }
        : { kind: "command", id: "SharePiece", label: "Share piece", icon: <Icon.Share aria-hidden="true" />,
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
          {copying.notice}
          {confirming ? <>
            <Button size="comfortable" emphasis="strong" onPointerDown={pointerDown} onKeyDown={keyDown}
              onFocus={(event) => focusControl(event.currentTarget)} onClick={(event) => activate(event, verbs.applySelection)}>apply selection</Button>
            <Button size="comfortable" onClick={verbs.bounds ? verbs.cancelBounds : verbs.dismissSelection}>cancel</Button>
          </> : <>
            {/* every selection becomes a new independent highlight, so the command never shows a persisted colour. */}
            <HighlightButton selected="yellow" persisted={false} disabledReason={null} busy={false}
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.highlightSelection(captured, "yellow"))} />
            <Button iconOnly icon={<Icon.Note aria-hidden="true" />} className={styles.selectionIcon} aria-label="Open passage note"
              onPointerDown={pointerDown} onKeyDown={keyDown} onFocus={(event) => focusControl(event.currentTarget)}
              onClick={(event) => activate(event, (captured) => verbs.composeSelection(captured, "Note"))} />
            {canQuote ? <Button iconOnly icon={<Icon.Chat aria-hidden="true" />} className={styles.selectionIcon} aria-label="Ask about passage"
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
  const transportVerbs = useTransportVerbs();
  const { composer, menu } = verbs;
  const { platform } = useRenderEnvironment();
  const visitScope = usePaneVisitWorkScope();
  const { draft, opening, annotation } = composer;
  const copying = usePassageCopy(draft?.id);
  const copy = copying.copy;
  const fieldId = useId();
  const chatFieldId = useId();
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const copyTrigger = useRef<HTMLButtonElement | null>(null);
  const destinationTrigger = useRef<HTMLButtonElement | null>(null);
  const annotationSerial = useRef(0);
  const [annotationRequest, setAnnotationRequest] = useState<{
    openingId: string; highlightId: string; serial: number; trigger: HTMLElement;
  } | null>(null);
  const pickerId = useId();
  const pickerAnchor = useCallback(() => isMobile ? moreTrigger.current : destinationTrigger.current, [isMobile]);
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const sourceChanged = draft?.issue?.kind === "Source" || (draft !== null && draft.highlightId === null && identity !== null && draft.passage.identity !== identity);
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
  const renderComposer = (placed: boolean, unavailable: boolean, headerOnly = false) => {
    if (!draft || !opening) return null;
    const annotationId = draft.bodyRole === "question" && store.getState().local.status !== "loading" && (!annotation || annotation.display) ? draft.highlightId : null;
    const annotationResource = annotation?.display?.projection ?? null;
    const hasNote = bodyHasContent(draft.body);
    const failed = draft.issue?.kind === "Failed" ? draft.issue : null;
    const refused = draft.issue?.kind === "Capture" || draft.issue?.kind === "Capacity" ? draft.issue : null;
    const saving = failed ? draft.operation !== null : draft.operation?.kind === "Save" || draft.operation?.kind === "Ensure";
    const blockedReason = failed ? "retry saving first."
      : sourceChanged ? "the text changed. select the passage again."
      : refused ? refused.line.fact
      : draft.chatIssue?.kind === "Passage" || draft.chatIssue?.kind === "Source" ? "select the passage again."
      : draft.attachmentActive ? "finish the attachment first."
      : draft.linkInputActive ? "finish the link first."
      : draft.referenceActive ? "finish the reference first."
      : draft.operation ? "the last action is still running."
      : unavailable && !draft.highlightId ? "this passage is no longer available." : null;
    const destination = draft.destination;
    const selected = destination.kind === "Selected" ? destination : null;
    const preparing = draft.chatAttempt?.kind === "Preparing" || draft.operation?.kind === "Chat" || draft.operation?.kind === "Ensure" || (selected?.snapshot.kind === "Loading")
      || draft.chatIssue?.kind === "Recall" && composer.recallPending;
    const sending = composer.ownChatCommand && composer.chatState.kind === "Busy";
    const continuationBlocked = (selected !== null && selected.snapshot.kind !== "Ready") || (hasNote && composer.chat?.target.kind === "Blocked");
    const hasMessage = convertReaderQuestion(draft.body).kind !== "Blank";
    const chatLabel = selected ? `${hasMessage ? "Send to" : "Open in"} “${selected.title}”` : "Choose existing chat";
    const chatIssue = draft.chatIssue;
    const blockedChat = composer.chat?.target.kind === "Blocked" ? composer.chat.target.reason === "AssistantRunning"
      ? "this chat is still responding." : "this chat can’t take a reply here."
      : selected?.snapshot.kind === "RefreshRequired" ? "this chat changed."
      : selected?.snapshot.kind === "Failed" ? "couldn’t load the chat." : null;
    const shortcut = usesMeta(platform) ? "cmd" : "ctrl";
    const command = (id: string, label: string, icon: ReactElement, onSelect: Extract<ActionDescriptor, { kind: "command" }>["onSelect"], reason: string | null): Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement } => ({
      kind: "command", id, label, icon, onSelect, disabled: reason !== null, disabledReason: reason ?? undefined,
    });
    const annotateAction = annotationId && annotationResource?.kind === "highlight" && annotationResource.authored_by_viewer
      ? command("EditHighlightAnnotation", annotationResource.body_pm_json === null ? "annotate" : "edit annotation",
        <ACTION_CATALOG.EditHighlightAnnotation.icon size={16} aria-hidden="true" />, ({ triggerEl }) => {
          if (!triggerEl) return;
          triggerEl.focus({ preventScroll: true });
          setAnnotationRequest({ openingId: opening.id, highlightId: annotationId, serial: ++annotationSerial.current, trigger: triggerEl });
        }, null) : null;
    const matchingRequest = annotateAction && annotationRequest?.openingId === opening.id && annotationRequest.highlightId === annotationId ? annotationRequest : null;
    // a failed local commit is retried as the same frozen command, never saved again.
    const saveAction = failed ? command("RetryPassageSave", "retry saving", <Icon.Again size={16} aria-hidden="true" />, failed.retry, saving ? "saving." : null)
      : command("SavePassageNote", draft.highlightId === null && !hasNote ? "save highlight" : "save annotation",
        <Icon.Save size={16} aria-hidden="true" />, composer.save, saving ? "saving." : blockedReason ?? (draft.highlightId !== null && !hasNote ? "write an annotation first." : null));
    const newLabel = hasMessage ? "Send in new chat" : "Open in new chat";
    const chatReason = blockedReason ?? ((hasMessage ? composer.chatLocked : composer.readerChatLocked) ? "another message is still pending." : null);
    const existingReason = chatReason ?? (preparing || destination.kind === "Resolving" ? "loading the chat." : continuationBlocked ? "this chat can’t take a reply here." : null);
    const newAction = command("NewChat", newLabel, <Icon.NewChat size={16} aria-hidden="true" />, ({ openIntent }) => composer.newChat(openIntent), chatReason);
    const existingAction = command("ExistingChat", chatLabel, <Icon.Chat size={16} aria-hidden="true" />, ({ openIntent }) => composer.continueChat(openIntent), existingReason);
    const chooseAction = { ...command("ChooseChat", "Choose existing chat", <Icon.Choose size={16} aria-hidden="true" />, composer.chooseChat,
      blockedReason ?? (composer.chatLocked ? "another message is still pending." : null)), restoreFocusOnClose: false };
    const selectAgain: Verb = { label: "select again", commandKey: "ReselectPassage", run: composer.reselect };
    const copyText: Verb = { label: "copy text", commandKey: "CopyDraftText", run: () => copy(draft.body.body_text) };
    const openChat: Verb = { label: "open chat", commandKey: "OpenDraftChat", run: composer.openChat };
    const openInChat: Verb = { label: "open in chat", commandKey: "OpenModelInChat", run: composer.recoverModel };
    const check: Verb = { label: "check", commandKey: "CheckDraftChat", run: composer.refreshChat };
    const chatField = chatFieldOf(composer, chatIssue, blockedChat, destination, { selectAgain, copyText, openChat, openInChat, check }, selected !== null, transportVerbs);
    const copyAction = command("CopyPassage", "Copy passage", copying.copied ? <Icon.Check size={16} aria-hidden="true" /> : <Icon.Copy size={16} aria-hidden="true" />, () => { if (composer.copyQuote !== null) copy(composer.copyQuote); },
      composer.copyUnavailable);
    // sharing a new passage first commits its highlight; an existing one shares as it is.
    const shareAction = { ...(sharePiece !== null
      ? command("SharePiece", "Share piece", <Icon.Share aria-hidden="true" />, ({ triggerEl }) => sharePiece(triggerEl), blockedReason)
      : command(draft.highlightId ? "ShareHighlight" : "SharePassage", draft.highlightId ? "Share highlight" : "Share passage", <Icon.Share aria-hidden="true" />,
        ({ triggerEl }) => verbs.share(triggerEl), draft.highlightId ? null : blockedReason)), hasPopup: "dialog" as const };
    const options: ActionDescriptor[] = isMobile ? [copyAction] : [];
    if (isMobile) {
      options.push({ kind: "custom", id: "HighlightColours", label: "Highlight colours", render: ({ closeMenu }) =>
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
      // menu-only words take no sign; `command` requires one because it also feeds the icon-only controls.
      if (annotation?.placement.kind === "placed") options.push({ kind: "command", id: "EditHighlightBounds", label: ACTION_CATALOG.EditHighlightBounds.label, icon: null,
        onSelect: () => verbs.editBounds(id), disabled: blockedReason !== null, disabledReason: blockedReason ?? undefined });
      const deleteReason = draft.operation ? "the last action is still running." : null;
      options.push({ kind: "command", id: "DeleteHighlight", label: ACTION_CATALOG.DeleteHighlight.label, icon: null, tone: "danger",
        onSelect: () => verbs.remove(id), disabled: deleteReason !== null, disabledReason: deleteReason ?? undefined });
    }
    const source: MenuSource = { kind: "Immediate", subjectKey: JSON.stringify([draft.id, opening.id, draft.highlightId]), title: "passage actions",
      content: { sections: [{ id: "Passage", label: null, options }] } };
    // the passage's one refusal, beneath the input; the save action it blocks or retries reads it.
    const passageField = refused && !sourceChanged ? <Field id={fieldId} line={refused.line} verbs={[selectAgain, copyText]} />
      : unavailable || sourceChanged ? <Field id={fieldId} line={draft.issue?.kind === "Source" ? draft.issue.line : SOURCE_CHANGED} verbs={[selectAgain, copyText]} />
      : failed?.phase === "Preparation" && !hasNote ? <Field key={failed.attempt} id={fieldId} line={{ fact: "couldn’t save the highlight." }} verbs={[retrySave(failed.retry, saving)]} />
      : null;
    const toolbar = <div className={styles.dock} data-selection-composer={opening.id} data-mobile={isMobile}>
      {isMobile ? <HighlightButton selected={annotation?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={blockedReason} busy={draft.operation?.kind === "Highlight"} onClick={() => verbs.highlight(annotation?.color ?? "yellow")} />
        : <HighlightColourPicker key={opening.id} selected={annotation?.color ?? "yellow"} persisted={draft.highlightId !== null} disabledReason={blockedReason} busy={draft.operation?.kind === "Highlight"} onSelect={verbs.highlight} />}
      {annotateAction ? <RecoverableSelectionAction action={annotateAction} help={annotateAction.label} busy={false}
        returnFocus={() => copyTrigger.current ?? moreTrigger.current ?? returnFocus()} onBlur={event => {
          const trigger = event.currentTarget;
          setAnnotationRequest(current => current?.openingId === opening.id && current.highlightId === annotationId && current.trigger === trigger ? null : current);
        }} /> : null}
      {draft.bodyRole === "annotation_or_question" || failed ? <SelectionAction action={saveAction} help={failed ? "retry saving" : `${saveAction.label} · enter saves and closes · shift-enter inserts a line`} busy={saving} describedBy={passageField ? fieldId : undefined} /> : null}
      {canQuote ? <>
        <SelectionAction action={newAction} help={`${newLabel} · ${shortcut}-enter`} busy={sending || preparing} describedBy={chatField ? chatFieldId : undefined} />
        {!isMobile ? <div className={styles.highlightControl}>
          <SelectionAction action={existingAction} help={`${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""} · ${shortcut}-shift-enter`} busy={sending || preparing} describedBy={chatField ? chatFieldId : undefined} />
          <Button ref={destinationTrigger} iconOnly className={styles.selectionIcon} aria-label="Choose existing chat" aria-haspopup="dialog"
            aria-expanded={composer.pickerOpen} aria-controls={composer.pickerOpen ? pickerId : undefined}
            aria-disabled={chooseAction.disabled || undefined} tooltip={{ text: chooseAction.disabledReason ? `Choose existing chat. ${chooseAction.disabledReason}` : "Choose existing chat" }}
            icon={<Icon.Choose aria-hidden="true" />} onClick={composer.chooseChat} />
        </div> : null}
      </> : null}
      {!isMobile ? <>
        <SelectionAction action={copyAction} help={copyAction.label} busy={false} buttonRef={copyTrigger} />
        <RecoverableSelectionAction action={shareAction} help={shareAction.label} busy={sharePiece === null && draft.operation?.kind === "Ensure"}
          returnFocus={() => copyTrigger.current ?? returnFocus()} />
      </> : null}
      {options.length > 0 ? <ActionMenu source={source} label="more passage actions" className={styles.selectionIcon} triggerRef={(node) => { moreTrigger.current = node; }} /> : null}
    </div>;
    if (headerOnly) return toolbar;
    return (
      <div data-mobile={isMobile} className={styles.selectionComposer}>
        {!isMobile ? toolbar : null}
        {annotation && annotation.placement.kind !== "placed" ? <PlacementNote kind={annotation.placement.kind} /> : null}
        {/* null means gone only once the store has read; until then the annotation waits */}
        {annotationId ? <PreparedResourcesContext value={annotation?.display?.resources ?? null}>
          <HighlightAnnotation highlightRef={`highlight:${annotationId}`} resource={annotationResource} occurrenceKey={`selection:highlight:${annotationId}`} onWorkOwners={composer.protectOwners}
            offerBlank={false} focusRequest={matchingRequest?.serial ?? null}
            onFocused={() => setAnnotationRequest(current => current === matchingRequest ? null : current)}
            mayFocus={() => matchingRequest === null || document.hasFocus() && document.activeElement === matchingRequest.trigger} />
        </PreparedResourcesContext> : null}
        <div data-selection-composer={opening.id} className={styles.selectionInput} onCompositionStartCapture={composer.compositionStart}
          onChangeCapture={composer.compositionStart} onPasteCapture={composer.compositionStart} onDropCapture={composer.compositionStart}>
          <PaneReturnVisitScope visitId={visitScope.visitId} routeKey={visitScope.routeKey}>
            <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`} containingNoteRef={null}
              body={draft.body} revision={draft.revision} label={draft.bodyRole === "question" ? "question about passage" : "annotation"}
              reference={composer.reference()} placeholder={draft.bodyRole === "question" || opening.mode === "Ask" ? "ask about this passage…" : "write an annotation…"} editable
              focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
              onEdit={composer.edit} onSelectionChange={composer.selection} onAttachmentActiveChange={composer.attachmentActive} onLinkInputActiveChange={composer.linkInputActive}
              history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
              onSave={draft.bodyRole === "question" ? undefined : composer.save} onNewChat={canQuote ? () => composer.newChat("default") : undefined}
              onContinueChat={canQuote ? () => composer.continueChat() : undefined}
            />
          </PaneReturnVisitScope>
        </div>
        {passageField}
        {failed?.phase === "Preparation" && hasNote
          ? <Hold id={`preparation:${draft.id}`} attempt={failed.attempt} risk line={UNSAVED} verbs={[retrySave(failed.retry, saving), copyText]} /> : null}
        {copying.notice}
        {canQuote && chatField ? <div data-selection-composer={opening.id} style={{ display: "contents" }}>
          <Field id={chatFieldId} line={chatField.line} verbs={chatField.verbs} />
        </div> : null}
      </div>
    );
  };
  const recolouring = verbs.recolouring ? store.annotation(verbs.recolouring) : null;
  return <>
    {composer.hiddenPreparationFailures.map(failure => <HiddenPreparationFailure key={failure.id} failure={failure} copy={copy} />)}
    {draft === null ? copying.notice : null}
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
      containsPoint={(event) => {
        if (!draft.highlightId || !event.isPrimary || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        const marks = reader.textMarksAt(event.clientX, event.clientY, event.target);
        return marks.length === 1 && marks[0]?.id === draft.highlightId;
      }} onDismiss={composer.dismiss}>
      {(placed, anchorState) => renderComposer(placed, anchorState === "unavailable")}
    </FloatingActionSurface> : null}
    {menu ? <FloatingActionSurface open anchor={chooserAnchor} subscribeAnchor={reader.subscribe} role="group" label="choose highlight" onDismiss={verbs.closeMenu}>
      <div className={styles.chooser}>
        <span>choose highlight</span>
        {menu.marks.map((mark) => {
          const own = store.annotation(mark.id);
          return <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
            {own ? localResourceLabel(own.projection) : "highlight"}
            <span>{mark.color} · {own ? `your highlight${own.body ? " · annotation" : ""}` : "shared highlight"}</span>
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

const UNSAVED = { fact: "this note isn’t saved yet." };
const retrySave = (retry: () => void, busy: boolean): Verb => ({ label: "retry", commandKey: "RetryPassagePreparation", run: retry, busy });

/** The chat half's one refusal, beneath the input; send is the retry. */
function chatFieldOf(composer: SelectionComposer, issue: NonNullable<SelectionComposer["draft"]>["chatIssue"], blocked: string | null,
  destination: NonNullable<SelectionComposer["draft"]>["destination"],
  verbs: Record<"selectAgain" | "copyText" | "openChat" | "openInChat" | "check", Verb>, selected: boolean, transportVerbs: ReturnType<typeof useTransportVerbs>): { line: { fact: string; reason?: string }; verbs?: Verbs } | null {
  if (issue?.kind === "Recall") return composer.recallFailed
    ? { line: { fact: "couldn’t load your last model." }, verbs: [{ label: "retry", commandKey: "RetryModelRecall", run: composer.retryRecall, busy: composer.recallPending }, verbs.openInChat] } : null;
  if (issue?.kind === "Transport") {
    const transport = transportOf(issue.error);
    return { line: TRANSPORT_LINES[transport].command(issue.fact), verbs: transportVerbs(transport) ?? undefined };
  }
  if (issue) {
    const line = issue.highlightSaved ? HIGHLIGHT_SAVED : issue.line;
    switch (issue.kind) {
      case "Catalog": return { line, verbs: [{ label: "retry", commandKey: "RetryModelList", run: composer.retryCatalog }, verbs.openInChat] };
      case "Passage": case "Source": return { line, verbs: [verbs.selectAgain, verbs.copyText] };
      case "Model": return { line, verbs: [verbs.openInChat] };
      case "Missing": return { line, verbs: [{ label: "choose chat", commandKey: "ChooseDraftChat", run: composer.chooseChat }] };
      case "Changed": return { line, verbs: [verbs.check, verbs.openChat] };
      case "Pending": return { line, verbs: selected ? [verbs.openChat] : undefined };
      case "Failed": return { line };
    }
  }
  if (blocked !== null) return { line: { fact: blocked }, verbs: [destination.kind === "Selected" && destination.snapshot.kind === "Failed"
    ? { label: "retry", commandKey: "RetryDraftChat", run: composer.refreshChat } : verbs.check, verbs.openChat] };
  if (destination.kind === "LookupFailed") {
    const transport = transportOf(destination.error);
    return { line: TRANSPORT_LINES[transport].read("recent chats"),
      verbs: transportVerbs(transport, { retry: { label: "retry", commandKey: "RetryRecentChats", run: composer.retryDefault } }) ?? undefined };
  }
  return null;
}

/** A draft that is no longer shown still owns its failed preparation: words at risk hold a risk
 * slip; a bare highlight says it once. */
function HiddenPreparationFailure({ failure, copy }: {
  readonly failure: SelectionComposer["hiddenPreparationFailures"][number];
  readonly copy: (text: string) => void;
}) {
  const { say } = useOutcome();
  const { issue, text, busy } = failure;
  useEffect(() => text === null ? say({ fact: "couldn’t save the highlight." }, [retrySave(issue.retry, false)]) : undefined, [issue, say, text]);
  return text === null ? null
    : <Hold id={`preparation:${failure.id}`} attempt={issue.attempt} risk line={UNSAVED} verbs={[retrySave(issue.retry, busy), { label: "copy text", commandKey: "CopyUnsavedText", run: () => copy(text) }]} />;
}
