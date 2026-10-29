"use client";
/** Header presentation of the outline's retained root. Disclosure never owns a
 * document, save boundary, query draft or undo chronology. */
import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode} from "react";
import {noteBodySchema, rawBodyText} from "@nexus/authored/body";
import {readBody} from "@nexus/authored/documents";
import type {WritingDocument} from "@/lib/notes/runtime";
import type {OutlineController, RootField} from "@/lib/notes/outlineController";
import type {PaneHeaderEditor} from "@/lib/panes/paneChrome";
import {hasActiveInteractionOwner, overlayOwnsHistoryTraversal, ownsOverlayFocus, useInteractionOwner} from "@/lib/ui/overlay";
import type {NoteEditorHandle} from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
import BoundPageTitleEditor from "./BoundPageTitleEditor";
import styles from "./AuthoredPaneRoot.module.css";

export function useAuthoredPaneRoot(controller: OutlineController | null, field: RootField | undefined) {
  const regionId = useId();
  const region = useRef<HTMLDivElement>(null), disclosure = useRef<HTMLButtonElement>(null);
  const [visit, setVisit] = useState({controller, expanded: false, opened: false});
  if (visit.controller !== controller) setVisit({controller, expanded: false, opened: false});
  const expanded = visit.controller === controller && visit.expanded;
  const visitRef = useRef(visit); visitRef.current = visit;
  const root = controller?.rootDocument ?? null;
  const [bound, setBound] = useState<{controller: OutlineController; document: WritingDocument; handle: NoteEditorHandle} | null>(null);
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
  const ownedFocus = useRef(false), pointer = useRef(false), pendingCollapse = useRef(false);
  const returnFocus = useRef(false);
  const firstFocus = useRef(false);
  const shownInspection = useRef<{controller: OutlineController; activationId: string} | null>(null);
  const inspection = field?.inspection ?? null;
  useLayoutEffect(() => {
    firstFocus.current = false; ownedFocus.current = false; pointer.current = false;
    pendingCollapse.current = false; returnFocus.current = false;
  }, [controller]);
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
    if (!pendingCollapse.current || pointer.current || !handle?.settleNativeInput()) return;
    pendingCollapse.current = false;
    setVisit(current => ({...current, expanded: false}));
    ownedFocus.current = false;
    if (returnFocus.current) disclosure.current?.focus({preventScroll: true});
    returnFocus.current = false;
  }, [handle]);
  const collapse = useCallback((focus: boolean) => {
    pendingCollapse.current = true; returnFocus.current = focus; attemptCollapse();
  }, [attemptCollapse]);
  const ready = useCallback((next: NoteEditorHandle | null) => {
    setBound(next && controller && root ? {controller, document: root, handle: next} : null);
  }, [controller, root]);
  const selectionChanged = useCallback((at: {anchor: number; head: number}) => {
    if (ownsFocus()) ownedFocus.current = true;
    controller?.onRootSelectionChange(at); attemptCollapse();
  }, [controller, attemptCollapse, ownsFocus]);
  const visible = useCallback((editor: NoteEditorHandle) => {
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
    const within = (target: EventTarget | null) => target instanceof Element && !!region.current &&
      (region.current.contains(target) || ownsOverlayFocus(region.current, target));
    const leave = () => {
      if (!document.hasFocus() || !ownedFocus.current || within(document.activeElement)) return;
      collapse(false);
    };
    const focus = (event: FocusEvent) => {
      if (within(event.target)) {ownedFocus.current = true; pendingCollapse.current = false;}
      else leave();
    };
    const blur = (event: FocusEvent) => {if (event.relatedTarget !== null && !within(event.relatedTarget)) queueMicrotask(leave);};
    let completion = 0;
    const down = (event: PointerEvent) => {cancelAnimationFrame(completion); pointer.current = !within(event.target);};
    const finish = () => {const outside = pointer.current; pointer.current = false; if (outside && !pendingCollapse.current) leave(); attemptCollapse(); controller?.blurRoot();};
    // A captured click can precede target handlers and their microtasks. Its
    // next rendering boundary certifies activation completion; pointerup cannot
    // do that for a delayed touch click. Native cancellation/drag end complete
    // their own gestures without predicting a click.
    const complete = () => {cancelAnimationFrame(completion); completion = requestAnimationFrame(finish);};
    const key = (event: KeyboardEvent) => {
      if (pointer.current) complete();
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || hasActiveInteractionOwner() || !within(event.target)) return;
      event.preventDefault(); collapse(true);
    };
    const back = () => {if (!overlayOwnsHistoryTraversal()) collapse(false);};
    document.addEventListener("focusin", focus); document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", down, true); document.addEventListener("click", complete, true);
    document.addEventListener("pointercancel", complete, true); document.addEventListener("dragend", complete, true); document.addEventListener("keydown", key);
    window.addEventListener("popstate", back);
    return () => {
      document.removeEventListener("focusin", focus); document.removeEventListener("focusout", blur);
      cancelAnimationFrame(completion);
      document.removeEventListener("pointerdown", down, true); document.removeEventListener("click", complete, true);
      document.removeEventListener("pointercancel", complete, true); document.removeEventListener("dragend", complete, true); document.removeEventListener("keydown", key);
      window.removeEventListener("popstate", back);
    };
  }, [expanded, controller, collapse, attemptCollapse]);
  useEffect(() => {
    if (expanded && ownedFocus.current && region.current && document.hasFocus() && document.activeElement !== document.body &&
      !region.current.contains(document.activeElement) && !ownsOverlayFocus(region.current, document.activeElement)) collapse(false);
  }, [interaction, expanded, collapse]);
  const focus = () => {if (ownsFocus()) controller?.setFocused(true);};
  const blur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element && region.current && (region.current.contains(next) || ownsOverlayFocus(region.current, next))) return;
    if (!pointer.current) queueMicrotask(() => controller?.blurRoot());
  };
  useEffect(() => {if (inspection && !inspection.restored && !inspection.signal.aborted) reveal();}, [inspection, reveal]);
  if (!controller || !field || !root || !history) return {rootEditor: null, rootTitle: null, rootReady: false};
  const page = controller.rootRef.startsWith("page:");
  if (page) return {rootTitle: root.doc.getText("title").toString() || field.placeholder || "untitled page", rootReady: handle !== null,
    rootEditor: {kind: "Inline", feedback: null, content: <RootAttachment controller={controller} handle={handle} visible ownsFocus={ownsFocus} reveal={reveal}><div ref={region} className={styles.title} data-outline-session={controller.pending.root_id} onFocusCapture={focus} onBlurCapture={blur}>
      <BoundPageTitleEditor header pageRef={controller.rootRef} document={root} history={history} label="page title" placeholder={field.placeholder}
        onEnter={() => controller.focusFirst()} onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>} satisfies PaneHeaderEditor};
  const body = noteBodySchema.nodeFromJSON(readBody(root.doc).body_pm_json);
  const text = rawBodyText(body);
  const line = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)[0]!;
  const blank = line.trim().length === 0;
  let omitted = body.content.size > 0 && blank;
  body.descendants(node => {if (node.type.name === "image" || node.type.name === "resource_embed") omitted = true;});
  const title = blank ? body.content.size ? "note" : "empty note" : line;
  const preview = title + (omitted || line.length < text.length ? "…" : "");
  return {rootTitle: title, rootReady: handle !== null, rootEditor: {kind: "Expandable", feedback: null, regionId, expanded,
    control: <button ref={disclosure} type="button" className={styles.disclosure} aria-label={expanded ? "collapse note" : `edit note: ${title}`}
      aria-controls={regionId} aria-expanded={expanded} onClick={() => {
        if (expandedRef.current) collapse(true);
        else {firstFocus.current = true; reveal();}
      }}><span className={styles.preview}>{preview}</span></button>,
    content: <RootAttachment controller={controller} handle={handle} visible={expanded} ownsFocus={ownsFocus} reveal={reveal} onVisible={visible}><div ref={region} className={styles.note} data-outline-session={controller.pending.root_id} onFocusCapture={focus} onBlurCapture={blur}>
      <AuthoredNoteEditor document={root} history={history} label="note body" header
        embedding={{row_id: controller.pending.root_id, context: controller.projection.context(controller.pending.root_id)}}
        reference={controller.projection.reference(controller.pending.root_id)} inspection={expanded || shownInspection.current?.controller === controller && shownInspection.current.activationId === inspection?.activationId ? inspection : null}
        onEditorReady={ready} onSelectionChange={selectionChanged}/>
    </div></RootAttachment>} satisfies PaneHeaderEditor};
}

/** Published nodes commit in the chrome subtree. The route's layout effect
 * precedes that commit, so only this retained attachment can certify visibility. */
function RootAttachment({controller, handle, visible, ownsFocus, reveal, onVisible, children}: {
  controller: OutlineController; handle: NoteEditorHandle | null; visible: boolean;
  ownsFocus(): boolean; reveal(): void; onVisible?(editor: NoteEditorHandle): void; children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (!handle) return;
    controller.attachRoot({handle, visible, ownsFocus, reveal});
    if (visible) onVisible?.(handle);
    return () => controller.attachRoot(null);
  }, [controller, handle, visible, ownsFocus, reveal, onVisible]);
  return children;
}
