"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import { fetchNoteBlock } from "@/lib/notes/api";
import {
  createOutlineDocFromBlock,
  firstOutlineBlockFromDoc,
} from "@/lib/notes/prosemirror/schema";
import {
  clearStoredNoteEditorDraft,
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
    bodyPmJson: Record<string, unknown>,
    baseRevision: number | null
  ) => Promise<HighlightLinkedNoteBlock>;
  onDelete: (
    noteBlockId: string,
    baseRevision: number,
    shouldApply: () => boolean
  ) => Promise<void>;
  onLocalChange?: () => void;
  onOpenLink: (href: string, options: { newPane: boolean }) => void;
}) {
  const feedback = useFeedback();
  const [editorResetVersion, setEditorResetVersion] = useState(0);
  const [resetDoc, setResetDoc] = useState<ProseMirrorNode | null>(null);
  const [conflictAction, setConflictAction] = useState<"overwrite" | "reload" | null>(null);
  const editVersionRef = useRef(0);
  const persistedBlockIdRef = useRef<string | null>(note?.note_block_id ?? null);
  const persistedRevisionRef = useRef<number | null>(note?.revision ?? null);
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
  const editorResourceKey = `${resourceKey}:editor:${editorResetVersion}`;
  const currentResourceKeyRef = useRef(resourceKey);

  useEffect(() => {
    currentResourceKeyRef.current = resourceKey;
    setResetDoc(null);
  }, [resourceKey]);

  useEffect(() => {
    if (
      noteBlockId &&
      noteBlockId !== persistedBlockIdRef.current &&
      noteBlockId === draftBlockId
    ) {
      persistedBlockIdRef.current = noteBlockId;
      persistedRevisionRef.current = note?.revision ?? null;
    }
  }, [draftBlockId, note?.revision, noteBlockId]);

  const initialDoc = useMemo(
    () =>
      resetDoc ??
      readStoredNoteEditorDraft(resourceKey)?.doc ??
      createOutlineDocFromBlock({
        id: note?.note_block_id ?? draftBlockId,
        bodyPmJson: note?.body_pm_json ?? null,
        bodyText: note?.body_text ?? "",
      }),
    [draftBlockId, note?.body_pm_json, note?.body_text, note?.note_block_id, resetDoc, resourceKey]
  );

  const saveDoc = useCallback(
    async (nextDoc: ProseMirrorNode) => {
      const saveResourceKey = resourceKey;
      const saveEditVersion = editVersionRef.current;
      const block = firstOutlineBlockFromDoc(nextDoc);
      if (!block) return;

      const persistedBlockId = persistedBlockIdRef.current;
      const persistedRevision = persistedRevisionRef.current;
      if (highlightNoteBodyHasContent(block)) {
        const savedBlock = await onSave(
          highlightId,
          persistedBlockId,
          block.id,
          block.bodyPmJson,
          persistedRevision
        );
        if (currentResourceKeyRef.current === saveResourceKey) {
          persistedBlockIdRef.current =
            savedBlock?.note_block_id ?? persistedBlockId ?? block.id;
          persistedRevisionRef.current = savedBlock?.revision ?? persistedRevision;
        }
        return;
      }

      if (persistedBlockId) {
        if (persistedRevision === null) {
          throw new Error("Highlight note is missing revision metadata");
        }
        const shouldApply = () =>
          currentResourceKeyRef.current === saveResourceKey &&
          editVersionRef.current === saveEditVersion;
        await onDelete(persistedBlockId, persistedRevision, shouldApply);
        if (shouldApply()) {
          persistedBlockIdRef.current = null;
          persistedRevisionRef.current = null;
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
    onConflict: (error) => {
      feedback.show(toFeedback(error, { fallback: "Note has a save conflict" }));
    },
  });
  const {
    status: saveStatus,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    reset: resetSession,
  } = session;

  const overwriteWithLocalDraft = useCallback(async () => {
    const persistedBlockId = persistedBlockIdRef.current;
    if (!persistedBlockId) {
      flushSession();
      return;
    }
    setConflictAction("overwrite");
    try {
      const latestBlock = await fetchNoteBlock(persistedBlockId);
      persistedRevisionRef.current = latestBlock.revision;
      flushSession();
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Latest note revision could not be loaded" }));
    } finally {
      setConflictAction(null);
    }
  }, [feedback, flushSession]);

  const reloadLatestNote = useCallback(async () => {
    const persistedBlockId = persistedBlockIdRef.current;
    setConflictAction("reload");
    try {
      clearStoredNoteEditorDraft(resourceKey);
      resetSession();
      if (!persistedBlockId) {
        setResetDoc(
          createOutlineDocFromBlock({
            id: draftBlockId,
            bodyPmJson: null,
            bodyText: "",
          })
        );
        setEditorResetVersion((version) => version + 1);
        return;
      }
      const latestBlock = await fetchNoteBlock(persistedBlockId);
      persistedBlockIdRef.current = latestBlock.id;
      persistedRevisionRef.current = latestBlock.revision;
      setResetDoc(
        createOutlineDocFromBlock({
          id: latestBlock.id,
          bodyPmJson: latestBlock.bodyPmJson,
          bodyText: latestBlock.bodyText,
        })
      );
      setEditorResetVersion((version) => version + 1);
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      feedback.show(toFeedback(error, { fallback: "Latest note could not be loaded" }));
    } finally {
      setConflictAction(null);
    }
  }, [draftBlockId, feedback, resetSession, resourceKey]);

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
        resourceKey={editorResourceKey}
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
      {saveStatus === "conflict" && editable ? (
        <div className={styles.conflictActions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void overwriteWithLocalDraft()}
            disabled={conflictAction !== null}
          >
            Keep local draft
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void reloadLatestNote()}
            disabled={conflictAction !== null}
          >
            Reload latest
          </Button>
        </div>
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
  if (status === "conflict") return "Conflict";
  return "";
}
