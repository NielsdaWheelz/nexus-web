"use client";
/** Presentation of the outline's retained root. Disclosure never owns a
 * document, save boundary, query draft or undo chronology. */
import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode} from "react";
import {noteBodySchema} from "@nexus/authored/body";
import {readBody} from "@nexus/authored/documents";
import {bodyDisplayText} from "@/lib/resources/localResource";
import type {WritingDocument} from "@/lib/notes/runtime";
import type {OutlineController, RootField} from "@/lib/notes/outlineController";
import type {PaneHeaderEditor} from "@/lib/panes/paneChrome";
import {hasActiveInteractionOwner, overlayOwnsHistoryTraversal, ownsOverlayFocus, useInteractionOwner} from "@/lib/ui/overlay";
import {usePointerGesture} from "@/lib/ui/pointerGesture";
import type {TextEditorHandle} from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
import BoundPageTitleEditor from "./BoundPageTitleEditor";
import styles from "./AuthoredPaneRoot.module.css";
import WorkCheckbox from "./WorkCheckbox";
import {useAccountToday} from "@/lib/notes/accountDay";

export type RootPresentation = "header" | "inline";

export function useAuthoredPaneRoot(controller: OutlineController | null, field: RootField | undefined, presentation: RootPresentation) {
  const today = useAccountToday();
  const inline = presentation === "inline";
  const regionId = useId();
  const region = useRef<HTMLDivElement>(null), disclosure = useRef<HTMLButtonElement>(null);
  const [visit, setVisit] = useState({controller, expanded: false, opened: false});
  if (visit.controller !== controller) setVisit({controller, expanded: false, opened: false});
  const expanded = visit.controller === controller && visit.expanded;
  const visitRef = useRef(visit); visitRef.current = visit;
  const root = controller?.rootDocument ?? null;
  const readingFrame = controller?.readingFrame() ?? null;
  const [bound, setBound] = useState<{controller: OutlineController; document: WritingDocument; handle: TextEditorHandle} | null>(null);
  const handle = bound?.controller === controller && bound.document === root ? bound.handle : null;
  const history = controller?.rootHistory() ?? null;
  const [, changed] = useState(0);
  useEffect(() => {
    if (!root) return;
    const update = () => changed(value => value + 1);
    root.doc.on("update", update);
    return () => {root.doc.off("update", update);};
  }, [root]);
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const ownedFocus = useRef(false), pendingCollapse = useRef(false);
  const returnFocus = useRef(false);
  const firstFocus = useRef(false);
  const shownInspection = useRef<{controller: OutlineController; activationId: string} | null>(null);
  const inspection = field?.inspection ?? null;
  const within = useCallback((target: EventTarget | null) => target instanceof Element && !!region.current &&
    (region.current.contains(target) || ownsOverlayFocus(region.current, target)), []);
  const {active, reset} = usePointerGesture({enabled: expanded, within, onComplete: outside => {
    if (outside && !pendingCollapse.current) leave();
    attemptCollapse(); controller?.blurRoot();
  }});
  useLayoutEffect(() => {
    firstFocus.current = false; ownedFocus.current = false; reset();
    pendingCollapse.current = false; returnFocus.current = false;
  }, [controller, reset]);
  const reveal = useCallback(() => {
    setVisit(current => current.controller === controller && current.expanded ? current : {controller, expanded: true, opened: current.controller === controller && current.opened});
  }, [controller]);
  const ownsFocus = useCallback(() => {
    const element = document.activeElement;
    if (!(element instanceof Element) || !region.current || !(region.current.contains(element) || ownsOverlayFocus(region.current, element))) return false;
    const editor = element.closest("[data-reference-editor]");
    return editor?.getAttribute("data-reference-editor") === controller?.rootRef || editor === null;
  }, [controller]);
  const attemptCollapse = useCallback(() => {
    if (!pendingCollapse.current || active() || !handle?.settleNativeInput() || inline && root?.hasPendingEdits()) return;
    pendingCollapse.current = false;
    setVisit(current => ({...current, expanded: false}));
    ownedFocus.current = false;
    if (returnFocus.current) disclosure.current?.focus({preventScroll: true});
    returnFocus.current = false;
  }, [handle, active, inline, root]);
  useEffect(() => root?.subscribePendingEdits(attemptCollapse), [root, attemptCollapse]);
  const collapse = useCallback((focus: boolean) => {
    pendingCollapse.current = true; returnFocus.current = focus; attemptCollapse();
  }, [attemptCollapse]);
  const leave = useCallback(() => {
    if (!document.hasFocus() || !ownedFocus.current || within(document.activeElement)) return;
    collapse(false);
  }, [within, collapse]);
  const ready = useCallback((next: TextEditorHandle | null) => {
    setBound(next && controller && root ? {controller, document: root, handle: next} : null);
  }, [controller, root]);
  const selectionChanged = useCallback((at: {anchor: number; head: number}) => {
    if (ownsFocus()) ownedFocus.current = true;
    controller?.onRootSelectionChange(at); attemptCollapse();
    if (controller !== null && controller.readingFrame() !== null) changed(value => value + 1);
  }, [controller, attemptCollapse, ownsFocus]);
  const visible = useCallback((editor: TextEditorHandle) => {
    if (controller && inspection && !inspection.signal.aborted) shownInspection.current = {controller, activationId: inspection.activationId};
    if (firstFocus.current) {
      firstFocus.current = false; ownedFocus.current = true;
      editor.focus(visitRef.current.opened ? editor.captureSelection() : {anchor: 1, head: 1}, visitRef.current.opened);
    }
    setVisit(current => current.controller === controller && !current.opened ? {...current, opened: true} : current);
  }, [controller, inspection]);
  const interaction = useInteractionOwner();
  useEffect(() => {
    if (!expanded) return;
    const focus = (event: FocusEvent) => {
      if (within(event.target)) {ownedFocus.current = true; pendingCollapse.current = false;}
      else leave();
    };
    const blur = (event: FocusEvent) => {if (event.relatedTarget !== null && !within(event.relatedTarget)) queueMicrotask(leave);};
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || hasActiveInteractionOwner() || !within(event.target)) return;
      event.preventDefault(); collapse(true);
    };
    const back = () => {if (!overlayOwnsHistoryTraversal()) collapse(false);};
    document.addEventListener("focusin", focus); document.addEventListener("focusout", blur); document.addEventListener("keydown", key);
    window.addEventListener("popstate", back);
    return () => {
      document.removeEventListener("focusin", focus); document.removeEventListener("focusout", blur); document.removeEventListener("keydown", key);
      window.removeEventListener("popstate", back);
    };
  }, [expanded, within, leave, collapse]);
  useEffect(() => {
    if (expanded && ownedFocus.current && region.current && document.hasFocus() && document.activeElement !== document.body &&
      !region.current.contains(document.activeElement) && !ownsOverlayFocus(region.current, document.activeElement)) collapse(false);
  }, [interaction, expanded, collapse]);
  const focus = () => {
    if (!ownsFocus()) return;
    if (controller !== null && controller.readingFrame() !== null) {void controller.focusRoot(); return;}
    ownedFocus.current = true; controller?.setFocused(true);
  };
  const blur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (within(event.relatedTarget)) return;
    if (!active()) queueMicrotask(() => {controller?.blurRoot(); if (inline && root?.doc.getText("title").length === 0) collapse(false);});
  };
  useEffect(() => {if (inspection && !inspection.restored && !inspection.signal.aborted) reveal();}, [inspection, reveal]);
  if (!controller || !field || !root || !history) return {rootEditor: null, rootTitle: null, rootReady: false, showTitle: reveal};
  const page = controller.rootRef.startsWith("page:");

  if (page) {
    const titleText = readingFrame !== null && handle ? handle.readText() : root.doc.getText("title").toString();
    const pageVisible = !inline || titleText.length > 0 || expanded || ownedFocus.current || root.hasPendingEdits();
    // Click follows pointer/touch attention capture; pointerdown only suppresses premature native focus.
    return {showTitle: reveal, rootTitle: titleText || field.placeholder || "untitled page", rootReady: handle !== null,
    rootEditor: {kind: "Inline", feedback: null, content: <RootAttachment controller={controller} handle={handle} visible={pageVisible} ownsFocus={ownsFocus} reveal={reveal}><div ref={region} hidden={!pageVisible} className={styles.title} data-outline-session={controller.pending.root_id}
      onPointerDownCapture={event => {if (event.button === 0 && controller.readingFrame() !== null && event.target instanceof HTMLTextAreaElement) event.preventDefault();}}
      onClick={event => {if (event.button === 0 && controller.readingFrame() !== null && event.target instanceof HTMLTextAreaElement) void controller.focusRoot();}}
      onFocusCapture={focus} onBlurCapture={blur}>
      <BoundPageTitleEditor header={inline ? undefined : true} pageRef={controller.rootRef} document={root} history={history} label="page title" placeholder={field.placeholder}
        readingFrame={readingFrame} onEnter={() => controller.focusFirst()} onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>} satisfies PaneHeaderEditor};
  }
  const saved = readBody(root.doc).body_pm_json;
  const body = noteBodySchema.nodeFromJSON(saved);
  const text = bodyDisplayText(saved);
  const line = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)[0]!;
  const blank = line.trim().length === 0;
  let omitted = body.content.size > 0 && blank;
  body.descendants(node => {if (node.type.name === "image" || node.type.name === "resource_embed") omitted = true;});
  const title = blank ? body.content.size ? "note" : "empty note" : line;
  const preview = title + (omitted || line.length < text.length ? "…" : "");
  return {showTitle: reveal, rootTitle: title, rootReady: handle !== null, rootEditor: {kind: "Expandable", feedback: null, regionId, expanded,
    control: <button ref={disclosure} type="button" className={styles.disclosure} data-outline-session={controller.pending.root_id} aria-label={expanded ? "collapse note" : `edit note: ${title}`}
      aria-controls={regionId} aria-expanded={expanded} onClick={() => {
        if (expandedRef.current) collapse(true);
        else {firstFocus.current = true; reveal();}
      }}><span className={styles.preview}>{preview}</span></button>,
    content: <RootAttachment controller={controller} handle={handle} visible={expanded} ownsFocus={ownsFocus} reveal={reveal} onVisible={visible}><div ref={region} className={styles.note} data-outline-session={controller.pending.root_id} onFocusCapture={focus} onBlurCapture={blur}>
      {controller.windows.get(controller.pending.root_id)?.rootResource ? <WorkCheckbox resource={controller.windows.get(controller.pending.root_id)!.rootResource!} today={today} history={controller.history}/> : null}
      <AuthoredNoteEditor document={root} history={history} label="note body" header
        embedding={{row_id: controller.pending.root_id, context: controller.projection.context(controller.pending.root_id)}}
        reference={controller.projection.reference(controller.pending.root_id)} inspection={expanded || shownInspection.current?.controller === controller && shownInspection.current.activationId === inspection?.activationId ? inspection : null}
        onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>} satisfies PaneHeaderEditor};
}

/** Published nodes commit in the chrome subtree. The route's layout effect
 * precedes that commit, so only this retained attachment can certify visibility. */
function RootAttachment({controller, handle, visible, ownsFocus, reveal, onVisible, children}: {
  controller: OutlineController; handle: TextEditorHandle | null; visible: boolean;
  ownsFocus(): boolean; reveal(): void; onVisible?(editor: TextEditorHandle): void; children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!handle) return;
    controller.attachRoot({handle, visible, ownsFocus, reveal});
    if (visible) onVisible?.(handle);
    return () => controller.attachRoot(null);
  }, [controller, handle, visible, ownsFocus, reveal, onVisible]);
  return children;
}
