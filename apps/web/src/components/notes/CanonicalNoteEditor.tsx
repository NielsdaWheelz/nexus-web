"use client";

// One canonical note occurrence. Content and acknowledgement belong to texts;
// the originating surface session owns operations, history and focus.
import NoteEditor, {
  type NoteInspection,
  type StructuralKeys,
} from "./NoteEditor";
import { NoteConflict } from "./NoteNotices";
import { useText } from "@/lib/notes/texts";
import type {
  BodyOccurrence,
  DailyPublication,
  OutlineDestination,
  OutlineSession,
} from "@/lib/notes/useOutlineSession";
import type { ResourceItem } from "@/lib/resources/items";

export default function CanonicalNoteEditor({
  session,
  occurrence,
  continuation,
  label,
  editable,
  inspection = null,
  embeddedItem = null,
  structuralKeys,
  atomicEmbeds = false,
  publication,
}: {
  session: OutlineSession;
  occurrence: BodyOccurrence;
  continuation: OutlineDestination | null;
  label: string;
  editable: boolean;
  inspection?: NoteInspection | null;
  embeddedItem?: ResourceItem | null;
  structuralKeys?: StructuralKeys;
  atomicEmbeds?: boolean;
  publication?: DailyPublication;
}) {
  const text = useText(occurrence.noteRef);
  if (!text || typeof text.value === "string") return null;
  const body = text.value;
  const selectedFocus =
    session.focus?.key === occurrence.key && session.focus.target === "text"
      ? session.focus
      : null;
  const canEdit =
    editable &&
    text.ready &&
    !text.gone &&
    (session.activeReference === null ||
      session.activeReference === occurrence.key);
  return (
    <>
      <NoteEditor
        editorKey={`${occurrence.noteRef}@${occurrence.key}`}
        occurrenceKey={occurrence.key}
        containingNoteRef={text.acked === null ? null : occurrence.noteRef}
        body={body}
        revision={text.revision}
        editable={canEdit}
        label={label.startsWith("edit note:") ? `edit note: ${body.body_text.split("\n")[0] || "note"}` : label}
        compact
        inspection={inspection}
        embeddedItem={embeddedItem}
        atomicEmbeds={atomicEmbeds}
        focus={selectedFocus}
        history={
          canEdit
            ? {
                undo: session.undo,
                redo: session.redo,
                boundary: session.boundary,
              }
            : null
        }
        reference={
          canEdit && continuation
            ? {
                source: text.acked === null ? null : continuation.source,
                recoverySource: continuation.source,
                textRef: occurrence.noteRef,
                label,
                position: continuation.position,
                onSelected: (target, targetItem, authored) => {
                  void session.insertReference({
                    destination: continuation,
                    target,
                    targetItem,
                    authored,
                    ...(publication ? { publication } : {}),
                    ...(text.acked === null
                      ? { creator: { noteRef: occurrence.noteRef, base: body } }
                      : {}),
                  });
                },
                onActiveChange: (active) =>
                  session.setReferenceActive(occurrence.key, active),
              }
            : null
        }
        keys={
          canEdit
            ? {
                ...structuralKeys,
                ...(continuation
                  ? ({
                      split: (left, right) => {
                        void session.splitNote({
                          occurrence,
                          left,
                          right,
                          destination: continuation,
                          ...(publication ? { publication } : {}),
                        });
                      },
                    } satisfies StructuralKeys)
                  : {}),
              }
            : null
        }
        onEdit={(edit) => session.editBody({ occurrence, edit })}
      />
      <NoteConflict textRef={occurrence.noteRef} />
    </>
  );
}
