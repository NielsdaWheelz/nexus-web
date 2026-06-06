"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import {
  createOutlineDocFromBlock,
  firstOutlineBlockFromDoc,
} from "@/lib/notes/prosemirror/schema";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
  type NoteEditorSessionStatus,
} from "@/lib/notes/useNoteEditorSession";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import styles from "./HighlightNoteEditor.module.css";

export default function HighlightNoteEditor({
  highlightId,
  note,
  editable,
  onSave,
  onDelete,
  onLocalChange,
  onOpenLink,
}: {
  highlightId: string;
  note: HighlightLinkedNoteBlock | null;
  editable: boolean;
  onSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>
  ) => Promise<HighlightLinkedNoteBlock>;
  onDelete: (noteBlockId: string, shouldApply: () => boolean) => Promise<void>;
  onLocalChange?: () => void;
  onOpenLink: (href: string, options: { newPane: boolean }) => void;
}) {
  const feedback = useFeedback();
  const editVersionRef = useRef(0);
  const persistedBlockIdRef = useRef<string | null>(note?.note_block_id ?? null);
  const draftBlockRef = useRef({
    highlightId,
    blockId: note?.note_block_id ?? newBlockId(),
  });

  const noteBlockId = note?.note_block_id ?? null;
  if (
    draftBlockRef.current.highlightId !== highlightId ||
    (noteBlockId !== null && noteBlockId !== draftBlockRef.current.blockId)
  ) {
    draftBlockRef.current = {
      highlightId,
      blockId: noteBlockId ?? newBlockId(),
    };
  }
  const draftBlockId = draftBlockRef.current.blockId;
  const resourceKey = `highlight:${highlightId}:${draftBlockId}`;
  const currentResourceKeyRef = useRef(resourceKey);

  useEffect(() => {
    currentResourceKeyRef.current = resourceKey;
  }, [resourceKey]);

  useEffect(() => {
    if (
      noteBlockId &&
      noteBlockId !== persistedBlockIdRef.current &&
      noteBlockId === draftBlockId
    ) {
      persistedBlockIdRef.current = noteBlockId;
    }
  }, [draftBlockId, noteBlockId]);

  const initialDoc = useMemo(
    () =>
      readStoredNoteEditorDraft(resourceKey)?.doc ??
      createOutlineDocFromBlock({
        id: note?.note_block_id ?? draftBlockId,
        bodyPmJson: note?.body_pm_json ?? null,
        bodyText: note?.body_text ?? "",
      }),
    [draftBlockId, note?.body_pm_json, note?.body_text, note?.note_block_id, resourceKey]
  );

  const saveDoc = useCallback(
    async (nextDoc: ProseMirrorNode) => {
      const saveResourceKey = resourceKey;
      const saveEditVersion = editVersionRef.current;
      const block = firstOutlineBlockFromDoc(nextDoc);
      if (!block) return;

      const persistedBlockId = persistedBlockIdRef.current;
      if (highlightNoteBodyHasContent(block)) {
        const savedBlock = await onSave(
          highlightId,
          persistedBlockId,
          block.id,
          block.bodyPmJson
        );
        if (currentResourceKeyRef.current === saveResourceKey) {
          persistedBlockIdRef.current =
            savedBlock?.note_block_id ?? persistedBlockId ?? block.id;
        }
        return;
      }

      if (persistedBlockId) {
        const shouldApply = () =>
          currentResourceKeyRef.current === saveResourceKey &&
          editVersionRef.current === saveEditVersion;
        await onDelete(persistedBlockId, shouldApply);
        if (shouldApply()) {
          persistedBlockIdRef.current = null;
        }
      }
    },
    [highlightId, onDelete, onSave, resourceKey]
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveDoc,
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Failed to save note" }));
    },
  });
  const {
    status: saveStatus,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
  } = session;

  const scheduleSave = useCallback(
    (nextDoc: ProseMirrorNode) => {
      editVersionRef.current += 1;
      onLocalChange?.();
      scheduleSessionSave(nextDoc);
    },
    [onLocalChange, scheduleSessionSave]
  );

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      onOpenLink(`/notes/${blockId}`, { newPane: openInNewPane });
    },
    [onOpenLink]
  );

  const openObject = useCallback(
    async (objectType: string, objectId: string, openInNewPane: boolean) => {
      if (!isObjectType(objectType)) return;
      let href: string | null = null;
      try {
        const [resolved] = await resolveObjectRefs([{ objectType, objectId }]);
        href = resolved?.route ?? null;
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        feedback.show(toFeedback(error, { fallback: "Linked object could not be opened." }));
        return;
      }
      if (!href) return;
      onOpenLink(href, { newPane: openInNewPane });
    },
    [feedback, onOpenLink]
  );

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <ProseMirrorOutlineEditor
        resourceKey={resourceKey}
        initialDoc={initialDoc}
        editable={editable}
        ariaLabel="Highlight note"
        createBlockId={newBlockId}
        singleBlock
        compact
        onDocChange={editable ? scheduleSave : undefined}
        onBlurFlush={flushSession}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
      />
      {saveLabelForStatus(saveStatus) ? (
        <div className={styles.status}>{saveLabelForStatus(saveStatus)}</div>
      ) : null}
    </div>
  );
}

function newBlockId(): string {
  return createRandomId();
}

function highlightNoteBodyHasContent(block: {
  bodyText: string;
  bodyPmJson: Record<string, unknown>;
}) {
  if (block.bodyText.trim()) {
    return true;
  }
  return bodyPmJsonHasAtomContent(block.bodyPmJson);
}

function bodyPmJsonHasAtomContent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "object_ref" || node.type === "image") {
    return true;
  }
  if (!Array.isArray(node.content)) {
    return false;
  }
  return node.content.some((child) => bodyPmJsonHasAtomContent(child));
}

function saveLabelForStatus(status: NoteEditorSessionStatus): string {
  if (status === "dirty") return "Unsaved";
  if (status === "saving") return "Saving...";
  if (status === "saved") return "Saved";
  if (status === "failed") return "Save failed";
  return "";
}
