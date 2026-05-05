"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { hrefForObject } from "@/lib/objectLinks";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  createOutlineDocFromBlock,
  firstOutlineBlockFromDoc,
} from "@/lib/notes/prosemirror/schema";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import styles from "./HighlightNoteEditor.module.css";

export interface HighlightLinkedNoteBlock {
  note_block_id: string;
  body_pm_json?: Record<string, unknown>;
  body_markdown?: string;
  body_text: string;
}

export default function HighlightNoteEditor({
  highlightId,
  note,
  editable,
  onSave,
  onDelete,
  onLocalChange,
}: {
  highlightId: string;
  note: HighlightLinkedNoteBlock | null;
  editable: boolean;
  onSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>
  ) => Promise<void>;
  onDelete: (noteBlockId: string) => Promise<void>;
  onLocalChange?: () => void;
}) {
  const feedback = useFeedback();
  const paneRuntime = usePaneRuntime();
  const saveScope = highlightId;
  const persistedBlockIdRef = useRef<string | null>(note?.note_block_id ?? null);
  const pendingDocRef = useRef<ProseMirrorNode | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savingScopesRef = useRef<Set<string>>(new Set());
  const queuedDocsRef = useRef<Map<string, ProseMirrorNode>>(new Map());
  const mountedRef = useRef(true);
  const currentSaveScopeRef = useRef(saveScope);
  const draftBlockRef = useRef({
    highlightId,
    noteBlockId: note?.note_block_id ?? null,
    blockId: note?.note_block_id ?? newBlockId(),
  });
  const [saveLabel, setSaveLabel] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentSaveScopeRef.current = saveScope;
  }, [saveScope]);

  const noteBlockId = note?.note_block_id ?? null;
  if (
    draftBlockRef.current.highlightId !== highlightId ||
    draftBlockRef.current.noteBlockId !== noteBlockId
  ) {
    draftBlockRef.current = {
      highlightId,
      noteBlockId,
      blockId: noteBlockId ?? newBlockId(),
    };
  }
  const draftBlockId = draftBlockRef.current.blockId;

  const doc = useMemo(
    () =>
      createOutlineDocFromBlock({
        id: note?.note_block_id ?? draftBlockId,
        bodyPmJson: note?.body_pm_json ?? null,
        bodyText: note?.body_text ?? "",
      }),
    [draftBlockId, note?.body_pm_json, note?.body_text, note?.note_block_id]
  );

  const saveDoc = useCallback(
    async (nextDoc: ProseMirrorNode) => {
      const scope = saveScope;
      if (savingScopesRef.current.has(scope)) {
        queuedDocsRef.current.set(scope, nextDoc);
        return;
      }
      const block = firstOutlineBlockFromDoc(nextDoc);
      if (!block) return;

      const persistedBlockId = persistedBlockIdRef.current;
      savingScopesRef.current.add(scope);
      if (mountedRef.current && currentSaveScopeRef.current === scope) {
        setSaveLabel("Saving...");
      }
      try {
        if (highlightNoteBodyHasContent(block)) {
          await onSave(highlightId, persistedBlockId, block.id, block.bodyPmJson);
          if (currentSaveScopeRef.current === scope) {
            persistedBlockIdRef.current = persistedBlockId ?? block.id;
          }
          if (mountedRef.current && currentSaveScopeRef.current === scope) {
            setSaveLabel("Saved");
          }
        } else if (persistedBlockId) {
          await onDelete(persistedBlockId);
          if (currentSaveScopeRef.current === scope) {
            persistedBlockIdRef.current = null;
          }
          if (mountedRef.current && currentSaveScopeRef.current === scope) {
            setSaveLabel("");
          }
        } else {
          if (mountedRef.current && currentSaveScopeRef.current === scope) {
            setSaveLabel("");
          }
        }
      } catch (error) {
        if (mountedRef.current && currentSaveScopeRef.current === scope) {
          feedback.show(toFeedback(error, { fallback: "Failed to save note" }));
          setSaveLabel("Save failed");
        }
      } finally {
        savingScopesRef.current.delete(scope);
        const queuedDoc = queuedDocsRef.current.get(scope);
        if (queuedDoc) {
          queuedDocsRef.current.delete(scope);
          void saveDoc(queuedDoc);
        }
      }
    },
    [feedback, highlightId, onDelete, onSave, saveScope]
  );

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pendingDoc = pendingDocRef.current;
    if (!pendingDoc) return;
    pendingDocRef.current = null;
    void saveDoc(pendingDoc);
  }, [saveDoc]);

  useEffect(() => {
    persistedBlockIdRef.current = note?.note_block_id ?? null;
    pendingDocRef.current = null;
    setSaveLabel("");
    return () => {
      flushPendingSave();
    };
  }, [flushPendingSave, highlightId, note?.note_block_id]);

  const scheduleSave = useCallback(
    (nextDoc: ProseMirrorNode) => {
      onLocalChange?.();
      pendingDocRef.current = nextDoc;
      setSaveLabel("Unsaved");
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        const pendingDoc = pendingDocRef.current;
        pendingDocRef.current = null;
        if (pendingDoc) void saveDoc(pendingDoc);
      }, 400);
    },
    [onLocalChange, saveDoc]
  );

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      const href = `/notes/${blockId}`;
      if (openInNewPane) paneRuntime?.openInNewPane(href);
      else paneRuntime?.router.push(href);
    },
    [paneRuntime]
  );

  const openObject = useCallback(
    async (objectType: string, objectId: string, openInNewPane: boolean) => {
      if (!isObjectType(objectType)) return;
      let href = hrefForObject({ objectType, objectId });
      if (!href) {
        try {
          const [resolved] = await resolveObjectRefs([{ objectType, objectId }]);
          href = resolved ? hrefForObject(resolved) : null;
        } catch (error: unknown) {
          feedback.show(toFeedback(error, { fallback: "Linked object could not be opened." }));
          return;
        }
      }
      if (!href) return;
      if (openInNewPane) paneRuntime?.openInNewPane(href);
      else paneRuntime?.router.push(href);
    },
    [feedback, paneRuntime]
  );

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <ProseMirrorOutlineEditor
        doc={doc}
        editable={editable}
        ariaLabel="Highlight note"
        createBlockId={newBlockId}
        singleBlock
        onDocChange={editable ? scheduleSave : undefined}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
      />
      {saveLabel ? <div className={styles.status}>{saveLabel}</div> : null}
    </div>
  );
}

function newBlockId(): string {
  return crypto.randomUUID();
}

export function highlightNoteBodyHasContent(block: {
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
