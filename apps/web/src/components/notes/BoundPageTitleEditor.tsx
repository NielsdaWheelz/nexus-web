"use client";
/** Titles retain their displayed Y.Text baseline through IME. An outline supplies
 * the same history owner as its body and structural commands; standalone title
 * fields keep an occurrence-local manager. Neither path creates note-body state. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { textReplacement } from "@nexus/authored/documents";
import type { Intent } from "@nexus/authored/commands";
import { useWritingDocument } from "@/lib/notes/hooks";
import type {WritingDocument} from "@/lib/notes/runtime";
import type { EditorHistory, OutlineHistory } from "@/lib/notes/structure";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type { NoteEditorHandle, NoteEditorProps, StructuralKeys } from "./NoteEditor";
import { outlineHistoryCommand, outlineStructuralCommand } from "@/lib/shortcuts";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
export default function BoundPageTitleEditor({ pageRef, document: suppliedDocument, label = "page title", editable = true, placeholder = "untitled page", onEnter, inputRef, prelude = [], initialTitle = "", session, structuralKeys, onEditorReady, onSelectionChange }: {
  document?: WritingDocument;
  session?: OutlineHistory; structuralKeys?: StructuralKeys; onEditorReady?: (editor: NoteEditorHandle | null) => void; onSelectionChange?: NoteEditorProps["onSelectionChange"];
  prelude?: readonly Intent[]; initialTitle?: string;
  pageRef: string; label?: string; editable?: boolean; placeholder?: string;
  onEnter?: () => void; inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { platform } = useRenderEnvironment();
  const { document: opened, error, retry } = useWritingDocument(suppliedDocument ? null : pageRef, prelude);
  const document = suppliedDocument ?? opened;
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const baseline = useRef<Y.Doc | null>(null);
  const composing = useRef(false);
  const nativeFlight = useRef(false);
  const nativeRelease = useRef<() => void>(() => undefined);
  const applying = useRef(false);
  const [value, setValue] = useState(() => suppliedDocument?.doc.getText("title").toString() ?? "");
  const origin = useRef(Symbol("title occurrence"));
  const manager = useRef<Y.UndoManager | null>(null);
  const history = useRef<EditorHistory | null>(null);
  const beforeSelection = useRef({anchor: 1, head: 1});
  const inputIntent = useRef(0);
  const pendingSelection = useRef<{input: HTMLTextAreaElement; anchor: number; head: number; intent: number} | null>(null);
  const latest = useRef({onEditorReady, onSelectionChange, onEnter, editable, session, structuralKeys});
  latest.current = {onEditorReady, onSelectionChange, onEnter, editable, session, structuralKeys};
  const selection = useCallback(() => ({anchor: (ref.current?.selectionStart ?? 0) + 1, head: (ref.current?.selectionEnd ?? 0) + 1}), [ref]);
  const step = useCallback((redo: boolean) => {
    if (history.current) {if (redo) history.current.redo(); else history.current.undo();}
    else if (redo) manager.current?.redo(); else manager.current?.undo();
    latest.current.onSelectionChange?.(selection());
  }, [selection]);
  useLayoutEffect(() => {
    if (!document) return;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(document.doc));
    baseline.current = doc;
    const shared = session?.editor(document) ?? null;
    history.current = shared;
    const release = shared?.retain() ?? (() => undefined);
    manager.current = shared ? null : new Y.UndoManager(document.doc.getText("title"), {trackedOrigins: new Set([origin.current])});
    setValue(doc.getText("title").toString());
    const receive = () => {
      if (composing.current || applying.current) return;
      const text = doc.getText("title"), input = ref.current;
      const pending = pendingSelection.current;
      const waiting = pending && pending.input === input && pending.intent === inputIntent.current ? pending : null;
      const start = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, waiting?.anchor ?? input?.selectionStart ?? 0));
      const end = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, waiting?.head ?? input?.selectionEnd ?? 0));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(document.doc, Y.encodeStateVector(doc)));
      const next = text.toString();
      pendingSelection.current = null;
      if (input && input.ownerDocument.activeElement === input) {
        const a = Y.createAbsolutePositionFromRelativePosition(start, doc)?.index ?? 0;
        const b = Y.createAbsolutePositionFromRelativePosition(end, doc)?.index ?? a;
        if (input.value === next) input.setSelectionRange(a, b);
        else pendingSelection.current = {input, anchor: a, head: b, intent: inputIntent.current};
      }
      setValue(next);
      if (input?.value === next) latest.current.onSelectionChange?.(selection());
    };
    const finish = () => queueMicrotask(() => {composing.current = false; receive(); shared?.boundary(); manager.current?.stopCapturing(); latest.current.onSelectionChange?.(selection());});
    document.doc.on("update", receive);
    const input = ref.current;
    input?.addEventListener("compositionend", finish);
    return () => { input?.removeEventListener("compositionend", finish); document.doc.off("update", receive); history.current = null; release(); baseline.current = null; manager.current?.clear(); manager.current?.destroy(); manager.current = null; doc.destroy(); };
  }, [document, ref, session, selection]);
  useLayoutEffect(() => {
    const pending = pendingSelection.current; pendingSelection.current = null;
    if (pending && pending.intent === inputIntent.current && ref.current === pending.input && pending.input.ownerDocument.activeElement === pending.input)
      pending.input.setSelectionRange(pending.anchor, pending.head);
    latest.current.onSelectionChange?.(selection());
  }, [value, ref, selection]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let retired = false;
    const release = () => {if (!retired) {nativeFlight.current = false; latest.current.onSelectionChange?.(selection());}};
    nativeRelease.current = release;
    const begin = (event: Event) => {
      nativeFlight.current = true;
      queueMicrotask(() => {if (event.defaultPrevented) release();});
    };
    const beforeInput = (event: Event) => {
      if (!(event instanceof InputEvent) || !latest.current.editable || event.isComposing || composing.current) return;
      inputIntent.current++;
      beforeSelection.current = selection();
      if (!event.cancelable) return;
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {event.preventDefault(); latest.current.onEnter?.();}
      else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {event.preventDefault(); step(event.inputType === "historyRedo");}
      else if (input.value.length === 0 && latest.current.structuralKeys?.emptyDelete && (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward")) {
        event.preventDefault(); latest.current.structuralKeys.emptyDelete(event.inputType === "deleteContentBackward" ? "backward" : "forward");
      }
    };
    input.addEventListener("keydown", begin, true); input.addEventListener("beforeinput", begin, true);
    input.addEventListener("keyup", release); input.addEventListener("blur", release);
    input.addEventListener("beforeinput", beforeInput);
    return () => {
      retired = true;
      nativeRelease.current = () => undefined;
      input.removeEventListener("keydown", begin, true); input.removeEventListener("beforeinput", begin, true);
      input.removeEventListener("keyup", release); input.removeEventListener("blur", release);
      input.removeEventListener("beforeinput", beforeInput); nativeFlight.current = false;
    };
  }, [document, ref, selection, step]);
  useLayoutEffect(() => {
    if (!document || !ref.current) return;
    const handle: NoteEditorHandle = {
      readSelection: () => selection(),
      settleNativeInput: () => !composing.current && !nativeFlight.current && !applying.current && pendingSelection.current === null && ref.current?.value === baseline.current?.getText("title").toString(),
      captureSelection: () => {
        const at = selection(), text = (baseline.current ?? document.doc).getText("title");
        const anchor = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, at.anchor - 1));
        const head = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, at.head - 1));
        return target => ({anchor: (Y.createAbsolutePositionFromRelativePosition(anchor, target.doc)?.index ?? at.anchor - 1) + 1, head: (Y.createAbsolutePositionFromRelativePosition(head, target.doc)?.index ?? at.head - 1) + 1});
      },
      focus: (requested, preventScroll) => {const at = typeof requested === "function" ? requested(document) : requested; const input = ref.current; if (!input) return; const a = at === "end" ? input.value.length : Math.max(0, at.anchor - 1), b = at === "end" ? a : Math.max(0, at.head - 1); input.focus({preventScroll}); input.setSelectionRange(a,b);},
      canArrange: () => !composing.current && !nativeFlight.current && !applying.current && pendingSelection.current === null && ref.current?.value === baseline.current?.getText("title").toString(),
      localHistory: command => {
        if (!handle.canArrange()) return {enabled: false, execute: () => undefined};
        if (latest.current.session) return null;
        return {enabled: (command === "undo" ? manager.current?.undoStack.length ?? 0 : manager.current?.redoStack.length ?? 0) > 0, execute: () => step(command === "redo")};
      },
    };
    latest.current.onEditorReady?.(handle);
    return () => latest.current.onEditorReady?.(null);
  }, [document, ref, selection, step]);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (!document || initialized.current === pageRef) return;
    initialized.current = pageRef;
    if (initialTitle && document.doc.getText("title").length === 0) document.doc.transact(() => document.doc.getText("title").insert(0,initialTitle), origin.current);
  }, [document, pageRef, initialTitle]);
  const change = (next: string) => {
    const doc = baseline.current;
    if (!doc || !document) return;
    const text = doc.getText("title"), edit = textReplacement(text.toString(), next);
    const editingOrigin = history.current?.origin ?? origin.current;
    applying.current = true;
    doc.transact(() => {text.delete(edit.from, edit.to - edit.from); text.insert(edit.from, edit.text);}, editingOrigin);
    Y.applyUpdate(document.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(document.doc)), editingOrigin);
    applying.current = false;
    const at = selection();
    history.current?.record({selectionBefore: beforeSelection.current, selectionAfter: at});
    beforeSelection.current = at;
    setValue(next); onSelectionChange?.(at);
  };
  if (error) return <div role="alert"><p>couldn’t open this title on this device.</p><Button onClick={retry}>retry</Button></div>;
  return <Textarea bare autoGrow={{minRows: 1, maxRows: 6}} ref={ref} value={value} aria-label={label} placeholder={placeholder} disabled={!editable || !document}
    onPointerDown={() => {inputIntent.current++;}}
    onInput={() => {const release = nativeRelease.current; queueMicrotask(release);}}
    onSelect={() => {inputIntent.current++; const at = selection(); beforeSelection.current = at; onSelectionChange?.(at);}}
    onBlur={() => {history.current?.boundary(); manager.current?.stopCapturing();}}
    onCompositionStart={() => {composing.current = true; beforeSelection.current = selection(); history.current?.boundary(); manager.current?.stopCapturing(); onSelectionChange?.(selection());}}
    onChange={event => change(event.target.value)} onKeyDown={event => {
      inputIntent.current++;
      if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
      const command = outlineStructuralCommand(event, platform);
      if (command && structuralKeys) {event.preventDefault(); const at = selection(); if (command === "indent") structuralKeys.indent?.(at); else if (command === "outdent") structuralKeys.outdent?.(at); else structuralKeys.move?.(command === "move_up" ? "up" : "down",at); return;}
      if (event.key === "Escape" && structuralKeys?.selectBlock) {event.preventDefault(); structuralKeys.selectBlock(); return;}
      if (value.length === 0 && structuralKeys?.emptyDelete && (event.key === "Backspace" || event.key === "Delete")) {event.preventDefault(); structuralKeys.emptyDelete(event.key === "Backspace" ? "backward" : "forward"); return;}
      const historyCommand = outlineHistoryCommand(event, platform);
      if (historyCommand) {event.preventDefault(); step(historyCommand === "redo");}
      else if (event.key === "Enter") {event.preventDefault(); onEnter?.();}
    }}/>;
}
