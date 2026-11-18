"use client";
/** Presentation of the outline's retained root. On the paper it is the pane's opening: a page's
 * title or a note's body, always shown, yielding the header's title while in view. Inline (a journal
 * day) a page's empty title folds away. Folding never owns a document, save boundary, query draft or
 * undo chronology. */
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode} from "react";
import {noteBodySchema} from "@nexus/authored/body";
import {readBody} from "@nexus/authored/documents";
import {bodyDisplayText} from "@/lib/resources/localResource";
import type {WritingDocument} from "@/lib/notes/runtime";
import type {OutlineController, RootField} from "@/lib/notes/outlineController";
import {usePaneTitleYield} from "@/lib/panes/paneChrome";
import {hasActiveInteractionOwner, overlayOwnsHistoryTraversal, ownsOverlayFocus, useInteractionOwner} from "@/lib/ui/overlay";
import {usePointerGesture} from "@/lib/ui/pointerGesture";
import type {TextEditorHandle} from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
import BoundPageTitleEditor from "./BoundPageTitleEditor";
import styles from "./AuthoredPaneRoot.module.css";
import WorkCheckbox from "./WorkCheckbox";
import {useAccountToday} from "@/lib/notes/accountDay";

export type RootPresentation = "paper" | "inline";

export function useAuthoredPaneRoot(controller: OutlineController | null, field: RootField | undefined, presentation: RootPresentation) {
  const today = useAccountToday();
  const inline = presentation === "inline";
  const region = useRef<HTMLDivElement>(null);
  const [visit, setVisit] = useState({controller, expanded: false});
  if (visit.controller !== controller) setVisit({controller, expanded: false});
  const expanded = inline && visit.controller === controller && visit.expanded;
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
  const ownedFocus = useRef(false), pendingCollapse = useRef(false);
  const inspection = field?.inspection ?? null;
  const within = useCallback((target: EventTarget | null) => target instanceof Element && !!region.current &&
    (region.current.contains(target) || ownsOverlayFocus(region.current, target)), []);
  const {active, reset} = usePointerGesture({enabled: expanded, within, onComplete: outside => {
    if (outside && !pendingCollapse.current) leave();
    attemptCollapse(); controller?.blurRoot();
  }});
  useLayoutEffect(() => {
    ownedFocus.current = false; reset(); pendingCollapse.current = false;
  }, [controller, reset]);
  // The paper's root is always shown: only an inline root unfolds.
  const reveal = useCallback(() => {
    if (inline) setVisit(current => current.controller === controller && current.expanded ? current : {controller, expanded: true});
  }, [controller, inline]);
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
  }, [handle, active, inline, root]);
  useEffect(() => root?.subscribePendingEdits(attemptCollapse), [root, attemptCollapse]);
  const collapse = useCallback(() => {
    pendingCollapse.current = true; attemptCollapse();
  }, [attemptCollapse]);
  const leave = useCallback(() => {
    if (!document.hasFocus() || !ownedFocus.current || within(document.activeElement)) return;
    collapse();
  }, [within, collapse]);
  const ready = useCallback((next: TextEditorHandle | null) => {
    setBound(next && controller && root ? {controller, document: root, handle: next} : null);
  }, [controller, root]);
  const selectionChanged = useCallback((at: {anchor: number; head: number}) => {
    if (ownsFocus()) ownedFocus.current = true;
    controller?.onRootSelectionChange(at); attemptCollapse();
    if (controller !== null && controller.readingFrame() !== null) changed(value => value + 1);
  }, [controller, attemptCollapse, ownsFocus]);
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
      event.preventDefault(); collapse();
    };
    const back = () => {if (!overlayOwnsHistoryTraversal()) collapse();};
    document.addEventListener("focusin", focus); document.addEventListener("focusout", blur); document.addEventListener("keydown", key);
    window.addEventListener("popstate", back);
    return () => {
      document.removeEventListener("focusin", focus); document.removeEventListener("focusout", blur); document.removeEventListener("keydown", key);
      window.removeEventListener("popstate", back);
    };
  }, [expanded, within, leave, collapse]);
  useEffect(() => {
    if (expanded && ownedFocus.current && region.current && document.hasFocus() && document.activeElement !== document.body &&
      !region.current.contains(document.activeElement) && !ownsOverlayFocus(region.current, document.activeElement)) collapse();
  }, [interaction, expanded, collapse]);
  const focus = () => {
    if (!ownsFocus()) return;
    if (controller !== null && controller.readingFrame() !== null) {void controller.focusRoot(); return;}
    ownedFocus.current = true; controller?.setFocused(true);
  };
  const blur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (within(event.relatedTarget)) return;
    if (!active()) queueMicrotask(() => {controller?.blurRoot(); if (inline && root?.doc.getText("title").length === 0) collapse();});
  };
  if (!controller || !field || !root || !history) return {rootEditor: null, rootTitle: null, rootReady: false, showTitle: reveal};
  const page = controller.rootRef.startsWith("page:");

  if (page) {
    const titleText = readingFrame !== null && handle ? handle.readText() : root.doc.getText("title").toString();
    const pageVisible = !inline || titleText.length > 0 || expanded || ownedFocus.current || root.hasPendingEdits();
    // Click follows pointer/touch attention capture; pointerdown only suppresses premature native focus.
    const title = <RootAttachment controller={controller} handle={handle} visible={pageVisible} ownsFocus={ownsFocus} reveal={reveal}><div ref={region} hidden={!pageVisible} className={inline ? styles.title : `${styles.title} ${styles.display}`} data-outline-session={controller.pending.root_id}
      onPointerDownCapture={event => {if (event.button === 0 && controller.readingFrame() !== null && event.target instanceof HTMLTextAreaElement) event.preventDefault();}}
      onClick={event => {if (event.button === 0 && controller.readingFrame() !== null && event.target instanceof HTMLTextAreaElement) void controller.focusRoot();}}
      onFocusCapture={focus} onBlurCapture={blur}>
      <BoundPageTitleEditor pageRef={controller.rootRef} document={root} history={history} label="page title" placeholder={field.placeholder}
        readingFrame={readingFrame} onEnter={() => controller.focusFirst()} onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>;
    return {showTitle: reveal, rootTitle: titleText || field.placeholder || "untitled page", rootReady: handle !== null,
      rootEditor: inline ? title : <PaperRoot>{title}</PaperRoot>};
  }
  const saved = readBody(root.doc).body_pm_json;
  const body = noteBodySchema.nodeFromJSON(saved);
  const text = bodyDisplayText(saved);
  const line = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)[0]!;
  const title = line.trim().length === 0 ? body.content.size ? "note" : "empty note" : line;
  // A note is always on the paper, whatever its presentation: no host folds a note's body.
  const resource = controller.windows.get(controller.pending.root_id)?.rootResource ?? null;
  return {showTitle: reveal, rootTitle: title, rootReady: handle !== null, rootEditor: <PaperRoot>
    <RootAttachment controller={controller} handle={handle} visible ownsFocus={ownsFocus} reveal={reveal}><div ref={region} className={styles.note} data-outline-session={controller.pending.root_id} onFocusCapture={focus} onBlurCapture={blur}>
      {resource ? <span className={styles.sign}><WorkCheckbox resource={resource} today={today} history={controller.history}/></span> : null}
      <AuthoredNoteEditor document={root} history={history} label="note body"
        embedding={{row_id: controller.pending.root_id, context: controller.projection.context(controller.pending.root_id)}}
        reference={controller.projection.reference(controller.pending.root_id)} inspection={inspection}
        onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>
  </PaperRoot>};
}

/** The paper's root yields the header's title while its top is in view. It owns the element it
 * measures, so the yield starts when the root first mounts, however late its read arrives. */
function PaperRoot({children}: {children: ReactNode}) {
  const name = useRef<HTMLDivElement>(null);
  usePaneTitleYield(name);
  return <div ref={name}>{children}</div>;
}

/** Published nodes commit in the chrome subtree. The route's layout effect
 * precedes that commit, so only this retained attachment can certify visibility. */
function RootAttachment({controller, handle, visible, ownsFocus, reveal, children}: {
  controller: OutlineController; handle: TextEditorHandle | null; visible: boolean;
  ownsFocus(): boolean; reveal(): void; children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!handle) return;
    controller.attachRoot({handle, visible, ownsFocus, reveal});
    return () => controller.attachRoot(null);
  }, [controller, handle, visible, ownsFocus, reveal]);
  return children;
}
