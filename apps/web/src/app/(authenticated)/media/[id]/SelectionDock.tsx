"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type FocusEventHandler, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from "react";
import * as Icon from "@/lib/ui/icons";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import { Field } from "@/components/feedback/Fact";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { Retract, Verb, Verbs } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import NoteEditor, { type NoteEditorHandle } from "@/components/notes/NoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import { PlacementNote } from "@/lib/documentReader/chrome/ReaderAnnotation";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import { localResourceLabel } from "@/lib/resources/localResource";
import { PaneReturnVisitScope, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { prepareActionSelect, type ActionDescriptor, type MenuSource } from "@/lib/ui/actionDescriptor";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { usesMeta } from "@/lib/shortcuts";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { useKeyboardReport } from "@/lib/ui/useKeyboardInset";
import { useOverlay } from "@/lib/ui/overlay";
import { isTextEntryTarget } from "@/lib/ui/eventTarget";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { convertReaderQuestion } from "@nexus/authored/markdown";
import { bodyHasContent } from "@nexus/authored/body";
import type { MediaAnnotations } from "./annotations";
import type { AnnotationVerbs, MobileSelection } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours } from "./HighlightColourPicker";
import { SOURCE_CHANGED, type SelectionComposer } from "./useSelectionComposer";
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

type SelectionActionPresentation = { readonly action: Extract<ActionDescriptor, { kind: "command" }> & { readonly icon: ReactElement } };

/** Primary commands share the overflow's descriptors and the common button contract. */
function SelectionAction({ action, help, busy, buttonRef, describedBy, onBlur }: SelectionActionPresentation & {
  readonly help: string;
  readonly busy: boolean;
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
  readonly onBlur?: FocusEventHandler<HTMLButtonElement>;
  /** A field this action retries. */
  readonly describedBy?: string;
}) {
  const reasonId = useId();
  // `command` gives every disabled action its reason.
  const reason = action.disabledReason ?? null;
  const activate = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (action.disabled) return;
    const detail = prepareActionSelect(event, event.currentTarget);
    if (detail) action.onSelect(detail);
  };
  return <>
    <Button ref={buttonRef} aria-disabled={reason !== null || undefined} iconOnly icon={action.icon} className={styles.selectionIcon}
      tooltip={{ text: reason ? `${help}. ${reason}` : help }} aria-label={action.label}
      aria-describedby={[describedBy, reason ? reasonId : null].filter(Boolean).join(" ") || undefined} data-action-id={action.id} aria-busy={busy || action.busy || undefined}
      aria-haspopup={action.hasPopup}
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

export default function SelectionDock({ verbs, store, reader, readerScrollport, isMobile, canQuote, returnFocus, sharePiece }: {
  readonly verbs: AnnotationVerbs;
  readonly store: MediaAnnotations;
  readonly reader: Reader;
  readonly readerScrollport: RefObject<HTMLElement | null>;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
  readonly returnFocus: () => HTMLElement | null;
  readonly sharePiece: ((trigger: HTMLElement | null) => void) | null;
}) {
  const transportVerbs = useTransportVerbs();
  const { composer, menu } = verbs;
  const { platform } = useRenderEnvironment();
  const visitScope = usePaneVisitWorkScope();
  const paneActive = usePaneIsActive();
  const viewport = useMobileViewport();
  const { draft, opening, annotation } = composer;
  const copying = usePassageCopy(draft?.id);
  const copy = copying.copy;
  const fieldId = useId();
  const chatFieldId = useId();
  const inputFieldId = useId();
  const refinementId = useId();
  const questionEditor = useRef<NoteEditorHandle | null>(null);
  const editorReady = useCallback((handle: NoteEditorHandle | null) => { questionEditor.current = handle; }, []);
  const annotationEditor = useRef<NoteEditorHandle | null>(null);
  const annotationEditorReady = useCallback((handle: NoteEditorHandle | null) => { annotationEditor.current = handle; }, []);
  const [inputRefusal, setInputRefusal] = useState<{ draftId: string; fact: string } | null>(null);
  const settleEditor = (editor: NoteEditorHandle | null) => {
    if (!draft) return false;
    if (!editor?.settleNativeInput()) {
      setInputRefusal({ draftId: draft.id, fact: editor ? "finish typing, then try again." : "the editor is still opening. try again." });
      return false;
    }
    setInputRefusal(null);
    return true;
  };
  const settleInput = (trigger: HTMLElement | null) => {
    trigger?.focus({ preventScroll: true });
    return settleEditor(questionEditor.current);
  };
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const copyTrigger = useRef<HTMLButtonElement | null>(null);
  const destinationTrigger = useRef<HTMLButtonElement | null>(null);
  const annotationSerial = useRef(0);
  const [annotationRequest, setAnnotationRequest] = useState<{
    openingId: string; highlightId: string; serial: number; trigger: HTMLElement;
  } | null>(null);
  const pickerId = useId();
  const pickerAnchor = useCallback(() => destinationTrigger.current, []);
  const mobileSurface = useRef<HTMLDivElement | null>(null);
  const mobileActive = isMobile && paneActive && (draft !== null && opening !== null || verbs.bounds !== null);
  const confirming = verbs.bounds !== null || composer.reselection !== null;
  const dismissMobile = () => {
    const ownsFocus = mobileSurface.current?.contains(document.activeElement) === true;
    if (verbs.bounds) verbs.cancelBounds();
    else if (composer.reselection) verbs.dismissSelection();
    else { composer.dismiss("escape"); return; }
    if (ownsFocus && paneActive) reader.focusSource();
  };
  useOverlay(mobileActive, { kind: "transient", workspaceNavigation: "allow", inside: () => [mobileSurface.current],
    dismissOnOutside: false, onDismiss: dismissMobile });
  useKeyboardReport(mobileActive);

  // A layout allocation may hide a low endpoint. Reveal it once, without a reader
  // navigation or a second clearance band; subsequent handle movement owns its scroll.
  const revealedSelection = useRef<string | null>(null);
  useLayoutEffect(() => {
    const selected = verbs.mobileSelection;
    if (!mobileActive || confirming || !selected || revealedSelection.current === selected.id) return;
    revealedSelection.current = selected.id;
    viewport.refreshGeometry();
    const geometry = reader.measurePassage(selected.capture);
    const scrollport = readerScrollport.current;
    const first = geometry?.lines[0], last = geometry?.lines.at(-1);
    if (!geometry || !scrollport || !first || !last) return;
    const room = Math.min(last.height, geometry.bounds.height / 4);
    const below = last.bottom + room - geometry.bounds.bottom;
    const above = first.top - room - geometry.bounds.top;
    if (below > 0) scrollport.scrollTop += below;
    else if (above < 0) scrollport.scrollTop += above;
  }, [mobileActive, confirming, verbs.mobileSelection, viewport, reader, readerScrollport]);

  const current = useRef(verbs);
  current.current = verbs;
  const transfer = useRef<MobileSelection | null>(null);
  const selectionFocus = useRef<{ subject: MobileSelection; control: Element } | null>(null);
  const applyPress = useRef<{
    subject: MobileSelection; control: HTMLButtonElement; pointer: number; x: number; y: number; released: boolean;
  } | null>(null);
  useEffect(() => {
    if (!mobileActive) return;
    const cancel = () => {
      applyPress.current = null;
      selectionFocus.current = null;
      transfer.current = null;
      current.current.cancelSelectionActivation();
    };
    const down = (event: globalThis.PointerEvent) => {
      const outside = !(event.target instanceof Node) || !mobileSurface.current?.contains(event.target);
      if (applyPress.current || outside && (transfer.current || selectionFocus.current)) cancel();
    };
    const move = (event: globalThis.PointerEvent) => {
      const held = applyPress.current;
      if (held && (held.pointer !== event.pointerId || Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8)) cancel();
    };
    const up = (event: globalThis.PointerEvent) => {
      const held = applyPress.current;
      if (!held || held.pointer !== event.pointerId) return;
      if (!event.composedPath().includes(held.control)) cancel();
      else held.released = true;
    };
    const cancelled = (event: globalThis.PointerEvent) => {
      if (applyPress.current?.pointer === event.pointerId || transfer.current || selectionFocus.current) cancel();
    };
    const tab = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing || !current.current.selectionVisible) return;
      const owned = selectionFocus.current;
      transfer.current = owned && document.activeElement === owned.control && current.current.selectionCurrent(owned.subject)
        ? owned.subject : current.current.captureSelection();
    };
    const outsideFocus = (event: globalThis.FocusEvent) => {
      if (event.target instanceof Node && mobileSurface.current?.contains(event.target)) return;
      if (transfer.current || selectionFocus.current) cancel();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && mobileSurface.current?.contains(event.target)) return;
      if (applyPress.current || selectionFocus.current) cancel();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancelled, true);
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    document.addEventListener("keydown", tab, true);
    document.addEventListener("focusin", outsideFocus, true);
    return () => {
      applyPress.current = null; selectionFocus.current = null; transfer.current = null;
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancelled, true);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", tab, true);
      document.removeEventListener("focusin", outsideFocus, true);
    };
  }, [mobileActive]);
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const button = event.target.closest("button");
    // Both owned editors keep their keyboard and the pressed control until click.
    if (button && isTextEntryTarget(document.activeElement) && event.currentTarget.contains(document.activeElement)) event.preventDefault();
    if (button?.dataset.passageApply === "true") {
      const owned = selectionFocus.current;
      const subject = owned && document.activeElement === owned.control && verbs.selectionCurrent(owned.subject)
        ? owned.subject : verbs.captureSelection();
      if (subject) {
        applyPress.current = { subject, control: button, pointer: event.pointerId, x: event.clientX, y: event.clientY, released: false };
        transfer.current = subject;
      }
      return;
    }
    if (!event.target.closest("[data-passage-interaction]") || button?.dataset.actionId === "EditHighlightAnnotation") return;
    composer.prepareInteraction();
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const button = event.target.closest("button"), active = document.activeElement;
    if (!button || !isTextEntryTarget(active) || !event.currentTarget.contains(active)) return;
    const editor = active?.closest("[data-highlight-annotation]") ? annotationEditor.current : questionEditor.current;
    // The press kept the control still; its semantic click now owns native focus.
    button.focus({ preventScroll: true });
    if (!settleEditor(editor)) { event.preventDefault(); event.stopPropagation(); }
  };
  const focus = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const applying = event.target instanceof HTMLButtonElement && event.target.dataset.passageApply === "true";
    if (!applying && (!event.target.closest("[data-passage-interaction]") || event.target.getAttribute("data-action-id") === "EditHighlightAnnotation")) {
      if (transfer.current) { transfer.current = null; verbs.cancelSelectionActivation(); }
      selectionFocus.current = null;
      return;
    }
    const subject = transfer.current ?? verbs.mobileSelection;
    transfer.current = null;
    const owned = subject !== null && verbs.ownSelectionFocus(subject);
    selectionFocus.current = owned ? { subject, control: event.target } : null;
    if (!applying) composer.prepareInteraction();
  };
  const apply = (event: MouseEvent<HTMLButtonElement>) => {
    if (verbs.mobileSelection === null || verbs.bounds?.phase === "Submitting") return;
    const held = applyPress.current;
    applyPress.current = null;
    const subject = event.detail > 0
      ? held?.released && held.control === event.currentTarget &&
        (!(event.nativeEvent instanceof globalThis.PointerEvent) || event.nativeEvent.pointerId <= 0 || event.nativeEvent.pointerId === held.pointer)
        ? held.subject : null
      : selectionFocus.current?.control === event.currentTarget ? selectionFocus.current.subject : null;
    if (subject && verbs.selectionCurrent(subject)) verbs.applySelection(subject);
  };
  const refinementControls = confirming ? <div className={styles.selectionRefinement}>
    <span id={refinementId}>{verbs.bounds?.issue?.fact ?? "select the passage, then apply."}</span>
    <Button size="comfortable" emphasis="strong" data-passage-apply="true"
      aria-describedby={refinementId}
      aria-disabled={verbs.mobileSelection === null || verbs.bounds?.phase === "Submitting" || undefined}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.repeat) { event.preventDefault(); return; }
        const owned = selectionFocus.current;
        if (owned?.control === event.currentTarget && verbs.selectionCurrent(owned.subject)) return;
        const subject = verbs.captureSelection();
        selectionFocus.current = subject ? { subject, control: event.currentTarget } : null;
      }} onClick={apply}>apply selection</Button>
    <Button size="comfortable" onClick={dismissMobile}>cancel</Button>
  </div> : null;

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
  const renderComposer = (placed: boolean, unavailable: boolean) => {
    if (!draft || !opening) return null;
    const fresh = draft.bodyRole === "annotation_or_question";
    const annotationId = !fresh && store.getState().local.status !== "loading" && (!annotation || annotation.display) ? draft.highlightId : null;
    const annotationResource = annotation?.display?.projection ?? null;
    const hasNote = bodyHasContent(draft.body);
    const failed = draft.issue?.kind === "Failed" ? draft.issue : null;
    const refused = draft.issue?.kind === "Capture" || draft.issue?.kind === "Capacity" ? draft.issue : null;
    const saving = failed ? draft.operation !== null : draft.operation?.kind === "Save" || draft.operation?.kind === "Ensure";
    const localReason = failed ? "retry saving first."
      : draft.attachmentActive ? "finish the attachment first."
      : draft.linkInputActive ? "finish the link first."
      : draft.referenceActive ? "finish the reference first."
      : draft.operation ? "the last action is still running." : null;
    const blockedReason = localReason ?? composer.selectionBlocked
      ?? (sourceChanged && draft.highlightId === null ? "the text changed. select the passage again."
        : refused ? refused.line.fact : unavailable && !draft.highlightId ? "this passage is no longer available." : null);
    const destination = draft.destination;
    const selected = destination.kind === "Selected" ? destination : null;
    const hasMessage = convertReaderQuestion(draft.body).kind !== "Blank";
    const chatLabel = selected ? `${hasMessage ? "send to" : "open in"} “${selected.title}”` : "choose chat";
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
    const inputIssue = inputRefusal?.draftId === draft.id ? inputRefusal : null;
    // A failed local commit retries its retained command, never a second save.
    const saveAction = failed ? command("RetryPassageSave", "retry saving", <Icon.Again size={16} aria-hidden="true" />, failed.retry, saving ? "saving." : null)
      : command("SavePassageNote", hasNote ? "save annotation" : "save highlight", <Icon.Save size={16} aria-hidden="true" />,
        ({ triggerEl }) => { if (settleInput(triggerEl)) composer.save(); }, blockedReason);
    const newLabel = hasMessage ? "send in new chat" : "open in new chat";
    const newAction = command("NewChat", newLabel, <Icon.NewChat size={16} aria-hidden="true" />,
      ({ triggerEl }) => { if (settleInput(triggerEl)) composer.newChat(); }, blockedReason);
    const existingAction = command("ExistingChat", chatLabel, <Icon.Chat size={16} aria-hidden="true" />,
      ({ triggerEl }) => {
        if (!selected) composer.chooseChat();
        else if (settleInput(triggerEl)) composer.continueChat();
      }, blockedReason);
    const highlightId = draft.highlightId;
    const selectAgain: Verb | null = highlightId === null
      ? { label: "select again", commandKey: "ReselectPassage", run: composer.reselect }
      : annotation?.placement.kind === "placed" ? { label: "adjust selection", commandKey: "EditHighlightBounds", run: () => verbs.editBounds(highlightId) }
        : annotation?.placement.kind === "unlocated" ? { label: "relocate highlight", commandKey: "RelocateHighlight", run: () => verbs.relocate(highlightId) } : null;
    const copyText: Verb = { label: "copy text", commandKey: "CopyDraftText", run: () => copy(draft.body.body_text) };
    const chatField = chatFieldOf(composer, transportVerbs);
    const copyAction = command("CopyPassage", "copy passage", copying.copied ? <Icon.Check size={16} aria-hidden="true" /> : <Icon.Copy size={16} aria-hidden="true" />, () => { if (composer.copyQuote !== null) copy(composer.copyQuote); }, composer.copyUnavailable);
    const shareAction = { ...(sharePiece !== null
      ? command("SharePiece", "share piece", <Icon.Share aria-hidden="true" />, ({ triggerEl }) => sharePiece(triggerEl), blockedReason)
      : command(draft.highlightId ? "ShareHighlight" : "SharePassage", draft.highlightId ? "share highlight" : "share passage", <Icon.Share aria-hidden="true" />,
        ({ triggerEl }) => verbs.share(triggerEl), draft.highlightId ? null : blockedReason)), hasPopup: "dialog" as const };
    const options: ActionDescriptor[] = isMobile ? [copyAction, shareAction] : [];
    if (isMobile && draft.highlightId === null) options.push({ kind: "command", id: "RefinePassage", label: "adjust selection", icon: null,
      onSelect: composer.reselect, disabled: localReason !== null || confirming, disabledReason: localReason ?? (confirming ? "apply or cancel the selection first." : undefined) });
    if (draft.highlightId) {
      const id = draft.highlightId;
      if (annotation?.placement.kind === "placed") options.push({ kind: "command", id: "EditHighlightBounds", label: ACTION_CATALOG.EditHighlightBounds.label, icon: null,
        onSelect: () => verbs.editBounds(id), disabled: localReason !== null || confirming, disabledReason: localReason ?? (confirming ? "apply or cancel the selection first." : undefined) });
      const deleteReason = draft.operation ? "the last action is still running." : null;
      options.push({ kind: "command", id: "DeleteHighlight", label: ACTION_CATALOG.DeleteHighlight.label, icon: null, tone: "danger",
        onSelect: () => verbs.remove(id), disabled: deleteReason !== null, disabledReason: deleteReason ?? undefined });
    }
    const source: MenuSource = { kind: "Immediate", subjectKey: JSON.stringify([draft.id, opening.id, draft.highlightId]), title: "passage actions",
      content: { sections: [{ id: "Passage", label: null, options }] } };
    const more = options.length > 0 ? <ActionMenu source={source} label="more passage actions" className={styles.selectionIcon} triggerRef={(node) => { moreTrigger.current = node; }} /> : null;
    const passageField = isMobile && composer.selectionBlocked && !confirming && verbs.mobileSelection === null
      ? <Field id={fieldId} line={{ fact: composer.selectionBlocked }} />
      : refused && !sourceChanged ? <Field id={fieldId} line={refused.line} verbs={selectAgain ? [selectAgain, copyText] : [copyText]} />
      : unavailable || sourceChanged ? <Field id={fieldId} line={draft.issue?.kind === "Source" ? draft.issue.line : SOURCE_CHANGED} verbs={selectAgain ? [selectAgain, copyText] : [copyText]} />
      : failed?.phase === "Preparation" && !hasNote ? <Field key={failed.attempt} id={fieldId} line={{ fact: "couldn’t save the highlight." }} verbs={[retrySave(failed.retry, saving)]} /> : null;
    const save = <SelectionAction action={saveAction} help={isMobile || failed ? saveAction.label : `${saveAction.label} · enter saves and closes · shift-enter inserts a line`} busy={saving}
      describedBy={[passageField ? fieldId : null, inputIssue ? inputFieldId : null].filter(Boolean).join(" ") || undefined} />;
    const chatDescription = [chatField ? chatFieldId : null, inputIssue ? inputFieldId : null].filter(Boolean).join(" ") || undefined;
    const toolbar = <div className={styles.dock} data-selection-composer={opening.id} data-mobile={isMobile} data-passage-interaction>
      <HighlightColourPicker key={opening.id} active={!isMobile || paneActive} selected={isMobile && fresh ? draft.color : annotation?.color ?? "yellow"} persisted={isMobile ? !fresh : draft.highlightId !== null}
        disabledReason={fresh ? blockedReason : localReason ?? (confirming ? "apply or cancel the selection first." : null)} busy={draft.operation?.kind === "Highlight"}
        onSelect={isMobile && fresh ? composer.setColor : verbs.highlight} primaryAction={isMobile && fresh ? save : undefined} size={isMobile ? "comfortable" : undefined} />
      {annotateAction ? <RecoverableSelectionAction action={annotateAction} help={annotateAction.label} busy={false}
        returnFocus={() => copyTrigger.current ?? moreTrigger.current ?? returnFocus()} onBlur={event => {
          const trigger = event.currentTarget;
          setAnnotationRequest(current => current?.openingId === opening.id && current.highlightId === annotationId && current.trigger === trigger ? null : current);
        }} /> : null}
      {(!isMobile && fresh) || failed && !fresh ? save : null}
      {canQuote ? <>
        <SelectionAction action={newAction} help={`${newLabel} · ${shortcut}-enter`} busy={false} describedBy={chatDescription} />
        <div className={styles.highlightControl}>
          <SelectionAction action={existingAction} help={`${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""} · ${shortcut}-shift-enter`} busy={false} describedBy={chatDescription} />
          <Button ref={destinationTrigger} iconOnly className={styles.selectionIcon} aria-label="choose existing chat" aria-haspopup="dialog"
            aria-expanded={composer.pickerOpen} aria-controls={composer.pickerOpen ? pickerId : undefined}
            aria-disabled={blockedReason !== null || undefined} tooltip={{ text: blockedReason ? `choose existing chat. ${blockedReason}` : "choose existing chat" }}
            icon={<Icon.Choose aria-hidden="true" />} onClick={() => { if (blockedReason === null) composer.chooseChat(); }} />
        </div>
      </> : null}
      {!isMobile ? <>
        <SelectionAction action={copyAction} help={copyAction.label} busy={false} buttonRef={copyTrigger} />
        <RecoverableSelectionAction action={shareAction} help={shareAction.label} busy={sharePiece === null && draft.operation?.kind === "Ensure"}
          returnFocus={() => copyTrigger.current ?? returnFocus()} />
        {more}
      </> : null}
    </div>;
    const savedAnnotation = <>
      {annotation && annotation.placement.kind !== "placed" ? <PlacementNote kind={annotation.placement.kind} /> : null}
      {annotationId ? <PreparedResourcesContext value={annotation?.display?.resources ?? null}>
        <HighlightAnnotation highlightRef={`highlight:${annotationId}`} resource={annotationResource} occurrenceKey={`selection:highlight:${annotationId}`} onWorkOwners={composer.protectOwners}
          onEditorReady={annotationEditorReady}
          offerBlank={false} focusRequest={matchingRequest?.serial ?? null}
          onFocused={() => setAnnotationRequest(current => current === matchingRequest ? null : current)}
          mayFocus={() => matchingRequest === null || document.hasFocus() && document.activeElement === matchingRequest.trigger} />
      </PreparedResourcesContext> : null}
    </>;
    const feedback = <>
      {inputIssue ? <Field id={inputFieldId} line={{ fact: inputIssue.fact }} /> : null}
      {passageField}
      {failed?.phase === "Preparation" && hasNote
        ? <Hold id={`preparation:${draft.id}`} attempt={failed.attempt} risk line={UNSAVED} verbs={[retrySave(failed.retry, saving), copyText]} /> : null}
      {canQuote && chatField ? <Field id={chatFieldId} line={chatField.line} verbs={chatField.verbs} /> : null}
    </>;
    return <div data-mobile={isMobile} className={styles.selectionComposer}>
      {toolbar}
      {isMobile ? <div className={styles.selectionDetails} data-fresh={fresh}>{refinementControls}{savedAnnotation}{feedback}</div> : savedAnnotation}
      <div className={isMobile ? styles.selectionInputRow : undefined}>
        <div data-selection-composer={opening.id} data-passage-interaction data-passage-question className={styles.selectionInput}
          onCompositionStartCapture={composer.compositionStart} onChangeCapture={composer.compositionStart} onPasteCapture={composer.compositionStart} onDropCapture={composer.compositionStart}>
          <PaneReturnVisitScope visitId={visitScope.visitId} routeKey={visitScope.routeKey}>
            <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`} containingNoteRef={null}
              onEditorReady={editorReady}
              body={draft.body} revision={draft.revision} label={fresh ? "note or question about passage" : "question about passage"}
              reference={composer.reference()} placeholder={fresh ? "note or question about passage…" : "question about passage…"} editable
              focus={!isMobile && placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
              onEdit={edit => { setInputRefusal(null); composer.edit(edit); }} onSelectionChange={composer.selection} onAttachmentActiveChange={composer.attachmentActive} onLinkInputActiveChange={composer.linkInputActive}
              history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
              onSave={!isMobile && fresh ? composer.save : undefined} onNewChat={canQuote ? () => composer.newChat() : undefined}
              onContinueChat={canQuote ? () => composer.continueChat() : undefined} />
          </PaneReturnVisitScope>
        </div>
        {isMobile ? <div className={styles.selectionSecondary}>
          <div data-passage-interaction>{more}</div>
          <Button iconOnly icon={<Icon.Dismiss />} aria-label="close passage composer" onClick={dismissMobile} />
        </div> : null}
      </div>
      {!isMobile ? feedback : null}
      {copying.notice}
    </div>;
  };
  const recolouring = verbs.recolouring ? store.annotation(verbs.recolouring) : null;
  return <>
    {composer.hiddenPreparationFailures.map(failure => <HiddenPreparationFailure key={failure.id} failure={failure} copy={copy} />)}
    {draft === null ? copying.notice : null}
    {isMobile ? (draft && opening) || verbs.bounds ? <div ref={mobileSurface} className={styles.mobileComposer} role="group" aria-label="passage composer"
      data-selection-composer={opening?.id} onPointerDownCapture={pointerDown} onClickCapture={click} onFocusCapture={focus}>
      {draft && opening ? renderComposer(true, false) : <div className={styles.selectionComposer} data-mobile="true"><div className={styles.selectionDetails}>{refinementControls}</div></div>}
    </div> : null : draft && opening ? <FloatingActionSurface open anchor={anchor} subscribeAnchor={reader.subscribe}
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
    {draft ? <ConversationDestinationOverlay key={draft.id} anchor={pickerAnchor} panelId={pickerId} open={composer.pickerOpen} mediaId={draft.sourceMediaId}
      onClose={composer.closePicker} onSelectConversation={composer.chooseDestination} /> : null}
  </>;
}

const UNSAVED = { fact: "this note isn’t saved yet." };
const retrySave = (retry: () => void, busy: boolean): Verb => ({ label: "retry", commandKey: "RetryPassagePreparation", run: retry, busy });

/** The source owns destination lookup and refusal before the new tab accepts. */
function chatFieldOf(composer: SelectionComposer,
  transportVerbs: ReturnType<typeof useTransportVerbs>): { line: { fact: string; reason?: string }; verbs?: Verbs } | null {
  const draft = composer.draft;
  if (!draft) return null;
  const issue = draft.chatIssue;
  if (issue) {
    switch (issue.kind) {
      case "Missing": return { line: issue.line, verbs: [{ label: "choose chat", commandKey: "ChooseDraftChat", run: composer.chooseChat }] };
      case "Failed": return { line: issue.line };
    }
  }
  if (draft.destination.kind === "LookupFailed") {
    const transport = transportOf(draft.destination.error);
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
