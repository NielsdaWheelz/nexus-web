"use client";
/** A title keeps its displayed Y.Text baseline through native composition. Empty
 * daily titles display a placeholder; the date default is never authored text. */
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { textReplacement } from "@nexus/authored/documents";
import type { Intent } from "@nexus/authored/commands";
import { useWritingDocument } from "@/lib/notes/hooks";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
export default function BoundPageTitleEditor({ pageRef, label = "page title", editable = true, placeholder = "untitled page", onEnter, inputRef, prelude = [], initialTitle = "" }: {
  prelude?: readonly Intent[]; initialTitle?: string;
  pageRef: string; label?: string; editable?: boolean; placeholder?: string;
  onEnter?: () => void; inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { document, error, retry } = useWritingDocument(pageRef, prelude);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const baseline = useRef<Y.Doc | null>(null);
  const composing = useRef(false);
  const applying = useRef(false);
  const [value, setValue] = useState("");
  const origin = useRef(Symbol("title occurrence"));
  const manager = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    if (!document) return;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(document.doc));
    baseline.current = doc;
    manager.current = new Y.UndoManager(document.doc.getText("title"), { trackedOrigins: new Set([origin.current]) });
    setValue(doc.getText("title").toString());
    const receive = () => {
      if (composing.current || applying.current) return;
      const text = doc.getText("title");
      const input = ref.current;
      const start = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, input?.selectionStart ?? 0));
      const end = Y.createRelativePositionFromTypeIndex(text, Math.min(text.length, input?.selectionEnd ?? 0));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(document.doc, Y.encodeStateVector(doc)));
      setValue(text.toString());
      if (input && input.ownerDocument.activeElement === input) {
        const a = Y.createAbsolutePositionFromRelativePosition(start, doc)?.index ?? 0;
        const b = Y.createAbsolutePositionFromRelativePosition(end, doc)?.index ?? a;
        requestAnimationFrame(() => { if (ref.current === input) input.setSelectionRange(a, b); });
      }
    };
    document.doc.on("update", receive);
    const finish = () => { queueMicrotask(() => { composing.current = false; receive(); }); };
    const input = ref.current;
    input?.addEventListener("compositionend", finish);
    return () => { input?.removeEventListener("compositionend", finish); document.doc.off("update", receive); baseline.current = null; manager.current?.destroy(); manager.current = null; doc.destroy(); };
  }, [document, ref]);
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (!document || initialized.current === pageRef) return;
    initialized.current = pageRef;
    if (initialTitle && document.doc.getText("title").length === 0) document.doc.transact(() => document.doc.getText("title").insert(0,initialTitle), origin.current);
  },[document,pageRef,initialTitle]);
  const change = (next: string) => {
    const doc = baseline.current;
    if (!doc || !document) return;
    const text = doc.getText("title"), old = text.toString();
    const edit=textReplacement(old,next);
    applying.current = true;
    doc.transact(() => { text.delete(edit.from, edit.to - edit.from); text.insert(edit.from, edit.text); }, origin.current);
    Y.applyUpdate(document.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(document.doc)), origin.current);
    applying.current = false;
    setValue(next);
  };
  if (error) return <div role="alert"><p>couldn’t open this title on this device.</p><Button onClick={retry}>retry</Button></div>;
  return <Textarea bare autoGrow={{minRows:1,maxRows:6}} ref={ref} value={value} aria-label={label} placeholder={placeholder} disabled={!editable || !document}
    onCompositionStart={() => { composing.current = true; manager.current?.stopCapturing(); }}
    onChange={event => change(event.target.value)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) manager.current?.redo(); else manager.current?.undo(); }
      else if (event.key === "Enter") { event.preventDefault(); onEnter?.(); }
    }} />;
}
