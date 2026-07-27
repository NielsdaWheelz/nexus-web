"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import NoteBodyEditor, { type NoteBodyChange, type NotePulseEditorTarget } from "@/components/notes/NoteBodyEditor";
import ResourceSurfaceBodyEditor from "@/components/resource-surface/ResourceSurfaceBodyEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { createRandomId } from "@/lib/createRandomId";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activateResource } from "@/lib/resources/activation";
import { fetchResourceSurface } from "@/lib/resourceSurface/api";
import { useResourceSurfaceSession } from "@/lib/resourceSurface/useResourceSurfaceSession";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import styles from "./ResourceSurfaceEditor.module.css";

const EMPTY_NOTE_BODY = {
  type: "paragraph",
} as Record<string, unknown>;

export default function ResourceSurfaceEditor({
  sourceRef,
  editable = true,
  focusMastheadSerial = 0,
  focusBodySerial = 0,
  onSurfaceReady,
  activateTarget,
  notePulseTarget,
}: {
  sourceRef: string;
  editable?: boolean;
  focusMastheadSerial?: number;
  focusBodySerial?: number;
  onSurfaceReady?: (surface: ResourceSurface) => void;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
}) {
  const [loaded, setLoaded] = useState<ResourceSurface | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [bodyFocus, setBodyFocus] = useState({ occurrenceId: null as string | null, serial: 0 });
  const titleRef = useRef<HTMLInputElement | null>(null);
  const onSurfaceReadyRef = useRef(onSurfaceReady);
  onSurfaceReadyRef.current = onSurfaceReady;

  useEffect(() => {
    let active = true;
    setLoaded(null);
    setFeedback(null);
    void fetchResourceSurface(sourceRef)
      .then((surface) => {
        if (!active) return;
        setLoaded(surface);
        onSurfaceReadyRef.current?.(surface);
      })
      .catch((error: unknown) => {
        if (!active || handleUnauthenticatedApiError(error)) return;
        setFeedback(toFeedback(error, { fallback: "This surface could not be loaded." }));
      });
    return () => {
      active = false;
    };
  }, [sourceRef]);

  if (feedback && !loaded) return <FeedbackNotice {...feedback} />;
  if (!loaded) return <PaneLoadingState />;
  return <LoadedResourceSurfaceEditor
    key={sourceRef}
    sourceRef={sourceRef}
    initialSurface={loaded}
    editable={editable}
    focusMastheadSerial={focusMastheadSerial}
    focusBodySerial={focusBodySerial}
    titleRef={titleRef}
    bodyFocus={bodyFocus}
    setBodyFocus={setBodyFocus}
    feedback={feedback}
    setFeedback={setFeedback}
    activateTarget={activateTarget}
    notePulseTarget={notePulseTarget}
  />;
}

function LoadedResourceSurfaceEditor({
  sourceRef,
  initialSurface,
  editable,
  focusMastheadSerial,
  focusBodySerial,
  titleRef,
  bodyFocus,
  setBodyFocus,
  feedback,
  setFeedback,
  activateTarget,
  notePulseTarget,
}: {
  sourceRef: string;
  initialSurface: ResourceSurface;
  editable: boolean;
  focusMastheadSerial: number;
  focusBodySerial: number;
  titleRef: React.RefObject<HTMLInputElement | null>;
  bodyFocus: { occurrenceId: string | null; serial: number };
  setBodyFocus: React.Dispatch<React.SetStateAction<{ occurrenceId: string | null; serial: number }>>;
  feedback: FeedbackContent | null;
  setFeedback: React.Dispatch<React.SetStateAction<FeedbackContent | null>>;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
}) {
  const session = useResourceSurfaceSession({
    sourceRef,
    initialSurface,
    onError: (error) => {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Changes are saved on this device until you retry." }));
    },
  });

  useEffect(() => {
    if (!focusMastheadSerial) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [focusMastheadSerial, titleRef]);

  useEffect(() => {
    if (!focusBodySerial) return;
    const first = session.surface.orderedItems[0];
    setBodyFocus({ occurrenceId: first?.occurrenceId ?? null, serial: focusBodySerial });
  }, [focusBodySerial, session.surface.orderedItems, setBodyFocus]);

  const insertNote = useCallback((position: { kind: "start" } | { kind: "after"; occurrenceId: string }) => {
    const noteId = createRandomId();
    session.command({ type: "insert_note", noteId, position, bodyPmJson: EMPTY_NOTE_BODY });
    setBodyFocus({ occurrenceId: `local:${noteId}`, serial: bodyFocus.serial + 1 });
  }, [bodyFocus.serial, session, setBodyFocus]);

  const splitNote = useCallback((input: {
    occurrenceId: string;
    leftBodyPmJson: Record<string, unknown>;
    rightBodyPmJson: Record<string, unknown>;
  }) => {
    const noteId = createRandomId();
    session.command({
      type: "split_note",
      occurrenceId: input.occurrenceId,
      noteId,
      leftBodyPmJson: input.leftBodyPmJson,
      rightBodyPmJson: input.rightBodyPmJson,
    });
    setBodyFocus({
      occurrenceId: `local:${noteId}`,
      serial: bodyFocus.serial + 1,
    });
  }, [bodyFocus.serial, session, setBodyFocus]);

  const onTitleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const first = session.surface.orderedItems[0];
    if (first?.target.content.kind === "note_body") {
      setBodyFocus({ occurrenceId: first.occurrenceId, serial: bodyFocus.serial + 1 });
      return;
    }
    insertNote({ kind: "start" });
  }, [bodyFocus.serial, insertNote, session.surface.orderedItems, setBodyFocus]);

  const activate = useCallback((item: ResourceSurface["orderedItems"][number]["target"]["item"], disposition: WorkspaceTargetDisposition) => {
    activateResource(item.activation, {
      labelHint: item.label,
      activateTarget,
      disposition,
    });
  }, [activateTarget]);

  const openObject = useCallback(async (
    objectType: string,
    objectId: string,
    disposition: WorkspaceTargetDisposition,
  ) => {
    const ref = `${objectType}:${objectId}`;
    if (!parseResourceRef(ref)) return;
    try {
      const [resolved] = await resolveResourceLocators([
        { kind: "resource_ref", ref },
      ]);
      const href = resolved?.resourceItem.route;
      if (!href) {
        setFeedback({
          severity: "warning",
          title: "Linked object could not be opened.",
        });
        return;
      }
      activateTarget({ target: { href }, disposition });
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(toFeedback(error, { fallback: "Linked object could not be opened." }));
    }
  }, [activateTarget, setFeedback]);

  const source = session.surface.source;
  const masthead = source.content.kind === "page_title" ? (
    <input
      ref={titleRef}
      className={styles.title}
      value={source.content.title}
      onChange={(event) => session.updateTitle(event.currentTarget.value)}
      onKeyDown={onTitleKeyDown}
      onBlur={session.flush}
      aria-label="Page title"
      readOnly={!editable}
    />
  ) : source.content.kind === "note_body" ? (
    <NoteBodyEditor
      resourceKey={sourceRef}
      initialBodyPmJson={source.content.bodyPmJson}
      fallbackBodyText={source.content.bodyText}
      editable={editable}
      ariaLabel="Note content"
      notePulseTarget={notePulseTarget}
      onBodyChange={(change: NoteBodyChange) => session.updateSourceNoteBody(change)}
      onBlurFlush={(change: NoteBodyChange) => session.updateSourceNoteBody({ ...change, flush: true })}
      onOpenObject={openObject}
      onFeedback={setFeedback}
      onError={(error) => setFeedback(toFeedback(error, { fallback: "This note could not be edited." }))}
    />
  ) : null;

  const failed = session.status === "failed";
  const recovery = failed || session.hasRecoveredDraft;
  return (
    <div className={styles.surface}>
      {recovery ? <div className={styles.recovery} data-state={failed ? "failed" : "recovered"} role={failed ? "alert" : "status"} aria-live="polite">
        <span>{failed ? "Changes are saved here until you retry." : "Recovered unsaved changes."}</span>
        <span className={styles.recoveryActions}>
          <Button size="sm" variant="secondary" onClick={session.retry}>Retry</Button>
          <Button size="sm" variant="ghost" onClick={() => void session.reload()}>Reload</Button>
          <Button size="sm" variant="ghost" onClick={() => void session.copyRecovery()}>Copy</Button>
        </span>
      </div> : null}
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <div className={styles.masthead}>{masthead}</div>
      <ResourceSurfaceBodyEditor
        sourceRef={sourceRef}
        orderedItems={session.surface.orderedItems}
        editable={editable}
        focusRequest={bodyFocus}
        onInsertNote={insertNote}
        onSplitNote={splitNote}
        onMoveOccurrence={({ occurrenceId, position }) => session.command({ type: "move_occurrence", occurrenceId, position })}
        onRemoveOccurrence={(occurrenceId) => session.command({ type: "remove_occurrence", occurrenceId })}
        onInsertResource={({ targetRef, position }) => session.command({ type: "insert_resource", targetRef, position })}
        onBodyChange={(change) => session.updateBody(change)}
        onBodyBlur={(change) => session.updateBody({ ...change, flush: true })}
        onActivate={activate}
        onOpenObject={openObject}
        onFeedback={setFeedback}
        onError={(error) => setFeedback(toFeedback(error, { fallback: "This surface could not be edited." }))}
      />
    </div>
  );
}
