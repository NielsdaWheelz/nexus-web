"use client";
/** Each attachment is an independent ordinary note. New explicit saves mint a
 * note/link pair; an empty slot is never a singleton claim or ownership relation. */
import type { Schema } from "@/lib/api/wire";
import BoundNoteEditor from "./BoundNoteEditor";
import ResourceComposer from "@/components/resources/ResourceComposer";
export default function AnnotationNoteHost({ target, noteRef, occurrenceKey, onChanged, label, editable = true }: {
  target: { kind: "highlight"; id: string } | { kind: "resource"; ref: string };
  noteRef: string | null; occurrenceKey: string; focusRequest: number;
  onActivate?: () => void; onChanged: () => void; onClose: () => void; label?: string;
  completeAnnotation?: Schema<"ResourceAnnotationOut"> | null; editable?: boolean;
  atomicEmbeds?: boolean; showItemsLabel?: boolean;
}) {
  if (noteRef !== null) return <BoundNoteEditor noteRef={noteRef} label={label ?? "edit passage note"} editable={editable} />;
  if (!editable) return null;
  return <ResourceComposer destinationRef={target.kind === "highlight" ? `highlight:${target.id}` : target.ref} occurrenceKey={occurrenceKey} label={label ?? "new passage note"} onSaved={onChanged} />;
}
