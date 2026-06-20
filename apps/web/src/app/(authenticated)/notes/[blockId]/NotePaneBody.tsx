"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneSecondary } from "@/components/workspace/PaneSecondary";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { saveNoteBody } from "@/lib/notes/api";
import type { NoteBlock } from "@/lib/notes/normalize";
import {
  createEmptyOutlineDoc,
  firstOutlineBlockFromDoc,
  noteBlocksToOutlineDoc,
} from "@/lib/notes/prosemirror/schema";
import { useNoteEditorSession } from "@/lib/notes/useNoteEditorSession";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { noteBlockResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { consumePendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { useNotePulseHighlight, type NotePulseTarget } from "@/lib/reader/pulseEvent";
import styles from "../../notes/notes.module.css";

const NOTE_PULSE_DURATION_MS = 1800;

export default function NotePaneBody() {
  const blockId = usePaneParam("blockId");
  if (!blockId) throw new Error("note route requires a block id");

  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPaneRoute = paneRuntime?.openInNewPane;
  const requestSecondarySurface = paneRuntime?.requestSecondarySurface;
  const [block, setBlock] = useState<NoteBlock | null>(null);
  const [initialDoc, setInitialDoc] = useState<ProseMirrorNode | null>(null);
  const [notePulseTarget, setNotePulseTarget] = useState<{
    blockId: string;
    startOffset: number;
    endOffset: number;
    pulseId: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const baseBodyVersionRef = useRef<number | null>(null);
  const currentDocRef = useRef<ProseMirrorNode | null>(null);
  const notePulseIdRef = useRef(0);
  const resourceKey = `note:${blockId}`;

  useSetPaneTitle(block?.bodyText.trim() || (feedback ? "Note" : null));

  const saveDoc = useCallback(
    async (doc: ProseMirrorNode, { clientMutationId }: { clientMutationId: string }) => {
      const first = firstOutlineBlockFromDoc(doc);
      if (!first) return;
      const saved = await saveNoteBody(blockId, {
        clientMutationId,
        baseVersion: baseBodyVersionRef.current,
        bodyPmJson: first.bodyPmJson,
      });
      baseBodyVersionRef.current = saved.versionByLane?.body ?? null;
      setBlock(saved);
    },
    [blockId],
  );

  const session = useNoteEditorSession({
    resourceKey,
    save: saveDoc,
    onError: (error) => {
      setFeedback(toFeedback(error, { fallback: "Note could not be saved." }));
    },
  });
  const {
    status: saveStatus,
    hasRecoveredDraft,
    scheduleSave,
    flush,
    retry,
    discardDraft,
    reset,
  } = session;

  const noteResource = useResource<NoteBlock, { blockId: string }>({
    descriptor: noteBlockResource,
    params: { blockId },
    load: (params, signal) =>
      paneResourceLoaders.note!.load(
        clientResourceFetcher(signal),
        params,
      ) as Promise<NoteBlock>,
  });

  useEffect(() => {
    setFeedback(null);
    setBlock(null);
    setInitialDoc(null);
    currentDocRef.current = null;
    reset();
  }, [blockId, reset]);

  useEffect(() => {
    if (noteResource.status === "ready") {
      const loaded = noteResource.data;
      baseBodyVersionRef.current = loaded.versionByLane?.body ?? null;
      setBlock(loaded);
      const doc = noteBlocksToOutlineDoc([loaded]);
      currentDocRef.current = doc;
      setInitialDoc(doc);
      return;
    }
    if (noteResource.status === "error") {
      if (handleUnauthenticatedApiError(noteResource.error)) return;
      setFeedback(toFeedback(noteResource.error, { fallback: "Note could not be loaded." }));
    }
  }, [noteResource]);

  const onDocChange = useCallback(
    (doc: ProseMirrorNode) => {
      currentDocRef.current = doc;
      scheduleSave(doc);
    },
    [scheduleSave],
  );

  const onBlurFlush = useCallback(
    (doc: ProseMirrorNode) => {
      currentDocRef.current = doc;
      flush(doc);
    },
    [flush],
  );

  const onOpenBlock = useCallback(
    (targetBlockId: string) => {
      if (targetBlockId) router.push(`/notes/${targetBlockId}`);
    },
    [router],
  );

  const openRoute = useCallback(
    (href: string, openInNewPane: boolean) => {
      if (openInNewPane) openInNewPaneRoute?.(href);
      else router.push(href);
    },
    [openInNewPaneRoute, router],
  );

  const paneOptions = useMemo(
    () => [
      {
        id: "show-note-connections",
        label: "Show connections",
        onSelect: () => {
          requestSecondarySurface?.("notes-connections");
        },
      },
    ],
    [requestSecondarySurface],
  );
  usePaneChromeOverride({ options: paneOptions });

  const secondaryDescriptor = useMemo(
    () => ({
      groupId: "notes-tools" as const,
      defaultSurfaceId: "notes-connections" as const,
      surfaces: [
        {
          id: "notes-connections" as const,
          body: (
            <ConnectionsSurface
              objectRef={{ objectType: "note_block", objectId: blockId }}
              onOpenRoute={openRoute}
            />
          ),
        },
      ],
    }),
    [blockId, openRoute],
  );
  usePaneSecondary(secondaryDescriptor);

  const pulseNoteBlock = useCallback((target: NotePulseTarget) => {
    const pulseId = notePulseIdRef.current + 1;
    notePulseIdRef.current = pulseId;
    setNotePulseTarget({
      blockId: target.blockId,
      startOffset: target.startOffset,
      endOffset: target.endOffset,
      pulseId,
    });
    window.setTimeout(() => {
      setNotePulseTarget((current) =>
        current?.pulseId === pulseId ? null : current,
      );
    }, NOTE_PULSE_DURATION_MS);
  }, []);

  const onNotePulse = useCallback(
    (target: NotePulseTarget) => {
      if (target.blockId !== blockId) return;
      pulseNoteBlock(target);
    },
    [blockId, pulseNoteBlock],
  );
  useNotePulseHighlight(onNotePulse);

  useEffect(() => {
    if (!initialDoc) return;
    const pending = consumePendingNoteActivation(blockId);
    if (!pending) return;
    pulseNoteBlock(pending);
  }, [blockId, initialDoc, pulseNoteBlock]);

  if (feedback && !initialDoc) return <FeedbackNotice {...feedback} />;
  if (!block || !initialDoc) return <PaneLoadingState />;

  return (
    <div className={styles.editorShell}>
      <NoteDraftRecovery
        status={saveStatus}
        hasRecoveredDraft={hasRecoveredDraft}
        onRetry={retry}
        onDiscard={() => {
          discardDraft();
          setInitialDoc(noteBlocksToOutlineDoc([block]));
        }}
      />
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <ProseMirrorOutlineEditor
        resourceKey={resourceKey}
        initialDoc={initialDoc ?? createEmptyOutlineDoc(createRandomId())}
        singleBlock
        createBlockId={() => blockId}
        ariaLabel="Note body"
        onDocChange={onDocChange}
        onBlurFlush={onBlurFlush}
        onOpenBlock={onOpenBlock}
        notePulseTarget={notePulseTarget}
        onError={(error) =>
          setFeedback(toFeedback(error, { fallback: "Note could not be edited." }))
        }
      />
    </div>
  );
}
