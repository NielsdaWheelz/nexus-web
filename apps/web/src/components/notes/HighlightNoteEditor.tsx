"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FeedbackNotice,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import { emptyNoteBody, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import {
  readStoredNoteEditorDraft,
  useNoteEditorSession,
} from "@/lib/notes/useNoteEditorSession";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import NoteBodyEditor from "@/components/notes/NoteBodyEditor";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { isRecord } from "@/lib/validation";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import styles from "./HighlightNoteEditor.module.css";

type HighlightNoteOperation = "Save" | "OpenLinkedObject";

function highlightNoteErrorMessage(
  error: unknown,
  operation: HighlightNoteOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const title =
    operation === "Save" ? "Highlight note wasn’t saved" : "Linked object wasn’t opened";
  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and try again.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Please wait a moment, then try again.",
        requestId,
      };
    case "E_NOT_FOUND":
      if (operation !== "Save") throw error;
      return {
        tone: "Danger",
        title: "This highlight is no longer available",
        message: "Copy any unsaved note text before refreshing the reader.",
        requestId,
      };
    case "E_NOTE_CONFLICT":
      if (operation !== "Save") throw error;
      return {
        tone: "Danger",
        title,
        message: "This note changed elsewhere. Discard this draft or refresh the reader.",
        requestId,
      };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      if (operation !== "Save") throw error;
      return {
        tone: "Danger",
        title,
        message: "This saved request no longer matches the draft. Discard it and try again.",
        requestId,
      };
    default:
      throw error;
  }
}

function attachmentErrorMessage(error: unknown): FeedbackContent {
  if (isApiError(error)) {
    return mediaCaptureErrorMessage(error, "AddAttachment");
  }
  if (!(error instanceof Error)) throw error;

  const modeledLocalFailure =
    error.message === "Select the note body or empty it before attaching a file." ||
    error.message === "Attach one file at a time here." ||
    error.message === "Only PDF and EPUB files are supported." ||
    /^(PDF|EPUB) files must not be empty\.$/.test(error.message) ||
    /^(PDF|EPUB) files must be \d+ MB or smaller\.$/.test(error.message) ||
    error.message === "Couldn’t save";
  if (!modeledLocalFailure) throw error;

  return {
    tone: "Danger",
    title: "Attachment wasn’t added",
    message:
      error.message === "Couldn’t save"
        ? "Check the URL and try again."
        : error.message,
  };
}

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
    clientMutationId: string,
  ) => Promise<HighlightLinkedNoteBlock>;
  onDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean,
  ) => Promise<void>;
  onLocalChange?: () => void;
  onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}) {
  const feedback = useFeedback();
  const [saveFailure, setSaveFailure] = useState<FeedbackContent | null>(null);
  const [attachmentFeedback, setAttachmentFeedback] =
    useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const editVersionRef = useRef(0);
  const persistedBlockIdRef = useRef<string | null>(
    note?.note_block_id ?? null,
  );
  const draftBlockRef = useRef({
    highlightId,
    blockId: note?.note_block_id ?? createRandomId(),
  });

  const noteBlockId = note?.note_block_id ?? null;
  if (
    draftBlockRef.current.highlightId !== highlightId ||
    (noteBlockId !== null && noteBlockId !== draftBlockRef.current.blockId)
  ) {
    draftBlockRef.current = {
      highlightId,
      blockId: noteBlockId ?? createRandomId(),
    };
  }
  const draftBlockId = draftBlockRef.current.blockId;
  const resourceKey = `highlight:${highlightId}:${draftBlockId}`;
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const editorResourceKey = `${resourceKey}:editor:${editorResetSerial}`;
  const currentResourceKeyRef = useRef(resourceKey);
  const loadedResourceKeyRef = useRef<string | null>(null);

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

  const persistedBody = useMemo<NoteBodyValue>(
    () => ({
      bodyPmJson: note?.body_pm_json ?? emptyNoteBody().bodyPmJson,
      bodyText: note?.body_text ?? "",
    }),
    [note?.body_pm_json, note?.body_text],
  );
  const [initialBody, setInitialBody] = useState(
    () => readStoredNoteEditorDraft(resourceKey)?.body ?? persistedBody,
  );

  const saveBody = useCallback(
    async (
      body: NoteBodyValue,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const saveResourceKey = resourceKey;
      const saveEditVersion = editVersionRef.current;

      const persistedBlockId = persistedBlockIdRef.current;
      if (noteBodyHasContent(body)) {
        const savedBlock = await onSave(
          highlightId,
          persistedBlockId,
          draftBlockId,
          body.bodyPmJson,
          clientMutationId,
        );
        if (currentResourceKeyRef.current === saveResourceKey) {
          persistedBlockIdRef.current =
            savedBlock?.note_block_id ?? persistedBlockId ?? draftBlockId;
        }
        return;
      }

      if (persistedBlockId) {
        const shouldApply = () =>
          currentResourceKeyRef.current === saveResourceKey &&
          editVersionRef.current === saveEditVersion;
        await onDelete(
          highlightId,
          persistedBlockId,
          clientMutationId,
          shouldApply,
        );
        if (shouldApply()) {
          persistedBlockIdRef.current = null;
        }
      }
    },
    [draftBlockId, highlightId, onDelete, onSave, resourceKey],
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveBody,
    draftMetadata: () => ({ blockId: draftBlockId }),
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setSaveFailure(highlightNoteErrorMessage(error, "Save"));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    },
  });
  const {
    status: saveStatus,
    hasRecoveredDraft,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    recoverDraft: recoverSessionDraft,
    retry: retrySession,
    discardDraft: discardSessionDraft,
  } = session;

  useEffect(() => {
    if (loadedResourceKeyRef.current === resourceKey) {
      return;
    }
    const isInitialLoad = loadedResourceKeyRef.current === null;
    loadedResourceKeyRef.current = resourceKey;
    const storedDraft = readStoredNoteEditorDraft(resourceKey);
    if (
      !noteBlockId &&
      storedDraft &&
      isRecord(storedDraft.metadata) &&
      typeof storedDraft.metadata.blockId === "string"
    ) {
      draftBlockRef.current.blockId = storedDraft.metadata.blockId;
    }
    setInitialBody(storedDraft?.body ?? persistedBody);
    if (!isInitialLoad) {
      setEditorResetSerial((current) => current + 1);
    }
    if (storedDraft) {
      recoverSessionDraft(storedDraft);
    }
  }, [noteBlockId, persistedBody, recoverSessionDraft, resourceKey]);

  const scheduleSave = useCallback(
    (body: NoteBodyValue) => {
      editVersionRef.current += 1;
      setSaveFailure(null);
      onLocalChange?.();
      scheduleSessionSave(body);
    },
    [onLocalChange, scheduleSessionSave],
  );

  const discardRecoveredDraft = useCallback(() => {
    discardSessionDraft();
    setInitialBody(persistedBody);
    setEditorResetSerial((current) => current + 1);
  }, [discardSessionDraft, persistedBody]);

  const openObject = useCallback(
    async (objectType: string, objectId: string, disposition: WorkspaceTargetDisposition) => {
      const ref = `${objectType}:${objectId}`;
      if (!parseResourceRef(ref)) return;
      let href: string | null = null;
      try {
        const [resolved] = await resolveResourceLocators([
          { kind: "resource_ref", ref },
        ]);
        href = resolved?.resourceItem.route ?? null;
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        try {
          feedback.publish({
            kind: "Hud",
            content: highlightNoteErrorMessage(error, "OpenLinkedObject"),
            actions: [
              {
                label: "Retry",
                onClick: () => void openObject(objectType, objectId, disposition),
              },
            ],
          });
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
        }
        return;
      }
      if (!href) return;
      onOpenLink(href, disposition);
    },
    [feedback, onOpenLink],
  );

  if (defect) throw defect.error;

  return (
    <div className={styles.shell} data-editable={editable ? "true" : "false"}>
      <NoteBodyEditor
        resourceKey={editorResourceKey}
        initialBodyPmJson={initialBody.bodyPmJson}
        fallbackBodyText={initialBody.bodyText}
        editable={editable}
        ariaLabel="Highlight note"
        compact
        onBodyChange={editable ? scheduleSave : undefined}
        onBlurFlush={flushSession}
        onOpenObject={openObject}
        onFeedback={setAttachmentFeedback}
        onError={(error) => {
          if (handleUnauthenticatedApiError(error)) return;
          try {
            setAttachmentFeedback(attachmentErrorMessage(error));
          } catch (caughtDefect) {
            setDefect({ error: caughtDefect });
          }
        }}
      />
      {attachmentFeedback ? (
        <FeedbackNotice
          content={attachmentFeedback}
          announcement={attachmentFeedback.tone === "Danger" ? "Assertive" : "Polite"}
        />
      ) : null}
      {saveStatus === "failed" && saveFailure ? (
        <FeedbackNotice
          content={saveFailure}
          announcement="Assertive"
          actions={[
            {
              label: "Retry",
              onClick: () => {
                setSaveFailure(null);
                retrySession();
              },
            },
            {
              label: "Discard",
              onClick: () => {
                setSaveFailure(null);
                discardRecoveredDraft();
              },
            },
          ]}
        />
      ) : (
        <NoteDraftRecovery
          status={saveStatus}
          hasRecoveredDraft={hasRecoveredDraft}
          onRetry={retrySession}
          onDiscard={discardRecoveredDraft}
        />
      )}
    </div>
  );
}
