"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Button from "@/components/ui/Button";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import NoteBodyEditor, {
  type NoteBodyChange,
  type NotePulseEditorTarget,
} from "@/components/notes/NoteBodyEditor";
import ResourceSurfaceBodyEditor from "@/components/resource-surface/ResourceSurfaceBodyEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { createRandomId } from "@/lib/createRandomId";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activateResource } from "@/lib/resources/activation";
import { fetchResourceSurface } from "@/lib/resourceSurface/api";
import {
  useResourceSurfaceSession,
  type DailyResourceSurfaceSession,
  type ResourceSurfaceSession,
} from "@/lib/resourceSurface/useResourceSurfaceSession";
import {
  draftNoteRef,
  provisionalDailyOccurrence,
} from "@/lib/resourceSurface/dailySurfacePersistence";
import {
  dailyDraftKey,
  readDailyDraft,
  subscribeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import { getPaneScrollContainer } from "@/lib/reader/paneScroll";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resolveResourceLocators } from "@/lib/resources/resourceLocators";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import type {
  PaneEntryDelivery,
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import styles from "./ResourceSurfaceEditor.module.css";

const EMPTY_NOTE_BODY = {
  type: "paragraph",
} as Record<string, unknown>;

export interface DailyResourceSurfaceEditorSource {
  accountId: string;
  localDate: string;
  materializedSourceRef?: string;
  delivery: PaneEntryDelivery | null;
  onDeliveryClaimed: (delivery: PaneEntryDelivery) => void;
}

const serverDailyDraftSnapshot = () => null;

function useDailyDraftSnapshot(daily?: DailyResourceSurfaceEditorSource) {
  const accountId = daily?.accountId;
  const localDate = daily?.localDate;
  const subscribe = useCallback(
    (listener: () => void) =>
      accountId && localDate
        ? subscribeDailyDraft(
            accountId,
            localDate,
            () => listener(),
          )
        : () => undefined,
    [accountId, localDate],
  );
  const getSnapshot = useCallback(
    () =>
      accountId && localDate && typeof window !== "undefined"
        ? window.localStorage.getItem(
            dailyDraftKey(accountId, localDate),
          )
        : null,
    [accountId, localDate],
  );
  const raw = useSyncExternalStore(
    subscribe,
    getSnapshot,
    serverDailyDraftSnapshot,
  );
  return useMemo(
    () =>
      accountId && localDate && raw !== null
        ? readDailyDraft(accountId, localDate)
        : null,
    [accountId, localDate, raw],
  );
}

type ResourceSurfaceEditorProps = (
  | { sourceRef: string; daily?: never }
  | { sourceRef?: never; daily: DailyResourceSurfaceEditorSource }
) & {
  rowFilterQuery?: string;
  editable?: boolean;
  focusMastheadSerial?: number;
  focusBodySerial?: number;
  onSurfaceChange?: (surface: ResourceSurface) => void;
  onDailyTitleChange?: (title: string | null) => void;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
};

export default function ResourceSurfaceEditor({
  sourceRef,
  daily,
  rowFilterQuery = "",
  editable = true,
  focusMastheadSerial = 0,
  focusBodySerial = 0,
  onSurfaceChange,
  onDailyTitleChange,
  activateTarget,
  notePulseTarget,
}: ResourceSurfaceEditorProps) {
  const [loadedState, setLoadedState] = useState<{
    sourceRef: string;
    surface: ResourceSurface;
  } | null>(null);
  const [feedbackState, setFeedbackState] = useState<{
    sourceRef: string;
    feedback: FeedbackContent;
  } | null>(null);
  const [bodyFocus, setBodyFocus] = useState({
    occurrenceId: null as string | null,
    serial: 0,
  });
  const titleRef = useRef<HTMLInputElement | null>(null);
  const ownerKey = daily
    ? `daily:${daily.accountId}:${daily.localDate}`
    : (sourceRef ?? "");
  const isDaily = daily !== undefined;
  const loadSourceRef = daily?.materializedSourceRef ?? sourceRef;
  const loaded =
    loadedState && loadedState.sourceRef === loadSourceRef
      ? loadedState.surface
      : null;
  const feedback =
    feedbackState?.sourceRef === ownerKey ? feedbackState.feedback : null;
  const setFeedback = useCallback(
    (next: FeedbackContent | null) =>
      setFeedbackState(
        next === null ? null : { sourceRef: ownerKey, feedback: next },
      ),
    [ownerKey],
  );

  useEffect(() => {
    if (!loadSourceRef) {
      if (isDaily) return;
      throw new Error("ResourceSurfaceEditor requires a source");
    }
    let active = true;
    setLoadedState(null);
    setFeedbackState(null);
    void fetchResourceSurface(loadSourceRef)
      .then((surface) => {
        if (!active) return;
        setLoadedState({ sourceRef: loadSourceRef, surface });
      })
      .catch((error: unknown) => {
        if (!active || handleUnauthenticatedApiError(error)) return;
        setFeedbackState({
          sourceRef: ownerKey,
          feedback: toFeedback(error, {
            fallback: "This surface could not be loaded.",
          }),
        });
      });
    return () => {
      active = false;
    };
  }, [isDaily, loadSourceRef, ownerKey]);

  if (daily) {
    if (daily.materializedSourceRef) {
      if (feedback && !loaded) return <FeedbackNotice {...feedback} />;
      if (!loaded) return <PaneLoadingState />;
    }
    return (
      <LoadedResourceSurfaceEditor
        key={`daily:${daily.accountId}:${daily.localDate}`}
        daily={daily}
        initialSurface={loaded ?? undefined}
        rowFilterQuery={rowFilterQuery}
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
        onSurfaceChange={onSurfaceChange}
        onDailyTitleChange={onDailyTitleChange}
      />
    );
  }
  if (!sourceRef) throw new Error("ResourceSurfaceEditor requires a source");
  if (feedback && !loaded) return <FeedbackNotice {...feedback} />;
  if (!loaded) return <PaneLoadingState />;
  return (
    <LoadedResourceSurfaceEditor
      key={sourceRef}
      sourceRef={sourceRef}
      rowFilterQuery={rowFilterQuery}
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
      onSurfaceChange={onSurfaceChange}
    />
  );
}

function LoadedResourceSurfaceEditor({
  sourceRef,
  daily,
  rowFilterQuery,
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
  onSurfaceChange,
  onDailyTitleChange,
}: {
  sourceRef?: string;
  daily?: DailyResourceSurfaceEditorSource;
  rowFilterQuery: string;
  initialSurface?: ResourceSurface;
  editable: boolean;
  focusMastheadSerial: number;
  focusBodySerial: number;
  titleRef: React.RefObject<HTMLInputElement | null>;
  bodyFocus: { occurrenceId: string | null; serial: number };
  setBodyFocus: React.Dispatch<
    React.SetStateAction<{ occurrenceId: string | null; serial: number }>
  >;
  feedback: FeedbackContent | null;
  setFeedback: (feedback: FeedbackContent | null) => void;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
  notePulseTarget?: NotePulseEditorTarget | null;
  onSurfaceChange?: (surface: ResourceSurface) => void;
  onDailyTitleChange?: (title: string | null) => void;
}) {
  const editorSessionKey = daily
    ? `daily:${daily.accountId}:${daily.localDate}`
    : sourceRef!;
  const dailyIdentity = daily
    ? `${daily.accountId}:${daily.localDate}`
    : null;
  const dailyDraft = useDailyDraftSnapshot(daily);
  const surfaceRootRef = useRef<HTMLDivElement | null>(null);
  const prependAnchorRef = useRef<{
    noteRef: string;
    top: number;
    scrollport: HTMLElement;
  } | null>(null);
  const sessionRef = useRef<
    ResourceSurfaceSession | DailyResourceSurfaceSession | null
  >(null);
  const reportError = useCallback((error: unknown) => {
    if (handleUnauthenticatedApiError(error)) return;
    setFeedback(
      toFeedback(error, {
        fallback: "Changes are saved on this device until you retry.",
      }),
    );
  }, [setFeedback]);
  const beforePrepend = useCallback((noteRef: string) => {
    const row = surfaceRootRef.current?.querySelector<HTMLElement>(
      `[data-note-ref="${noteRef}"]`,
    );
    const scrollport = getPaneScrollContainer(row ?? null);
    if (row && scrollport) {
      prependAnchorRef.current = {
        noteRef,
        top: row.getBoundingClientRect().top,
        scrollport,
      };
    }
  }, []);
  const claimDelivery = useCallback(
    (delivery: PaneEntryDelivery, noteId: string) => {
      const noteRef = draftNoteRef(noteId);
      const canonical = sessionRef.current?.surface?.orderedItems.find(
        (row) => row.target.item.ref === noteRef,
      );
      setBodyFocus((current) => ({
        occurrenceId:
          canonical?.occurrenceId ?? `daily-provisional:${noteId}`,
        serial: current.serial + 1,
      }));
      daily?.onDeliveryClaimed(delivery);
    },
    [daily, setBodyFocus],
  );
  const session = useResourceSurfaceSession(
    daily
      ? {
          sessionKey: editorSessionKey,
          daily: {
            accountId: daily.accountId,
            localDate: daily.localDate,
          },
          delivery: daily.delivery,
          draftSnapshot: dailyDraft,
          ...(initialSurface && daily.materializedSourceRef
            ? {
                initialMaterialized: {
                  sourceRef: daily.materializedSourceRef,
                  surface: initialSurface,
                },
              }
            : {}),
          onDeliveryClaimed: claimDelivery,
          beforePrepend,
          onError: reportError,
        }
      : {
          sourceRef: sourceRef!,
          initialSurface: initialSurface!,
          onError: reportError,
        },
  );
  sessionRef.current = session;
  const surface = session.surface;
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    const row = surfaceRootRef.current?.querySelector<HTMLElement>(
      `[data-note-ref="${anchor.noteRef}"]`,
    );
    if (row) {
      anchor.scrollport.scrollTop +=
        row.getBoundingClientRect().top - anchor.top;
    }
  }, [surface]);
  const onSurfaceChangeRef = useRef(onSurfaceChange);
  onSurfaceChangeRef.current = onSurfaceChange;
  useEffect(() => {
    if (surface) onSurfaceChangeRef.current?.(surface);
  }, [surface]);
  const dailyTitle = "title" in session ? session.title : null;
  useEffect(() => {
    if (dailyIdentity) onDailyTitleChange?.(dailyTitle);
  }, [dailyIdentity, dailyTitle, onDailyTitleChange]);

  useEffect(() => {
    if (!focusMastheadSerial) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [focusMastheadSerial, titleRef]);

  useEffect(() => {
    if (!focusBodySerial) return;
    const first = surface?.orderedItems[0];
    setBodyFocus({
      occurrenceId: first?.occurrenceId ?? null,
      serial: focusBodySerial,
    });
  }, [focusBodySerial, setBodyFocus, surface]);

  const insertNote = useCallback(
    (position: { kind: "start" } | { kind: "after"; occurrenceId: string }) => {
      const noteId = createRandomId();
      session.command({
        type: "insert_note",
        noteId,
        position,
        bodyPmJson: EMPTY_NOTE_BODY,
      });
      setBodyFocus((current) => ({
        occurrenceId:
          daily && !surface
            ? `daily-provisional:${noteId}`
            : `local:${noteId}`,
        serial: current.serial + 1,
      }));
    },
    [daily, session, setBodyFocus, surface],
  );

  const splitNote = useCallback(
    (input: {
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
      setBodyFocus((current) => ({
        occurrenceId: `local:${noteId}`,
        serial: current.serial + 1,
      }));
    },
    [session, setBodyFocus],
  );

  const onTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      )
        return;
      event.preventDefault();
      const first = surface?.orderedItems[0];
      if (first?.target.content.kind === "note_body") {
        setBodyFocus((current) => ({
          occurrenceId: first.occurrenceId,
          serial: current.serial + 1,
        }));
        return;
      }
      insertNote({ kind: "start" });
    },
    [insertNote, setBodyFocus, surface],
  );

  const activate = useCallback(
    (
      item: ResourceSurface["orderedItems"][number]["target"]["item"],
      disposition: WorkspaceTargetDisposition,
    ) => {
      activateResource(item.activation, {
        labelHint: item.label,
        activateTarget,
        disposition,
      });
    },
    [activateTarget],
  );

  const openObject = useCallback(
    async (
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
        setFeedback(
          toFeedback(error, { fallback: "Linked object could not be opened." }),
        );
      }
    },
    [activateTarget, setFeedback],
  );

  const dailySession = "provisional" in session ? session : null;
  const provisional = dailySession?.provisional ?? null;
  const orderedItems = useMemo(
    () => [
      ...(surface?.orderedItems ?? []),
      ...(provisional ? [provisionalDailyOccurrence(provisional)] : []),
    ],
    [provisional, surface],
  );
  const source = surface?.source ?? null;
  const masthead =
    source?.content.kind === "page_title" ? (
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
    ) : source?.content.kind === "note_body" &&
      "updateSourceNoteBody" in session ? (
      <NoteBodyEditor
        resourceKey={editorSessionKey}
        initialBodyPmJson={source.content.bodyPmJson}
        fallbackBodyText={source.content.bodyText}
        editable={editable}
        ariaLabel="Note content"
        notePulseTarget={notePulseTarget}
        onBodyChange={(change: NoteBodyChange) =>
          session.updateSourceNoteBody(change)
        }
        onBlurFlush={(change: NoteBodyChange) =>
          session.updateSourceNoteBody({ ...change, flush: true })
        }
        onOpenObject={openObject}
        onFeedback={setFeedback}
        onError={(error) =>
          setFeedback(
            toFeedback(error, { fallback: "This note could not be edited." }),
          )
        }
      />
    ) : dailyTitle !== null ? (
      <input
        ref={titleRef}
        className={styles.title}
        value={dailyTitle}
        aria-label="Page title"
        readOnly
      />
    ) : (
      <div aria-label="Page title loading" aria-busy="true" />
    );

  const failed = session.status === "failed";
  const recovery = failed || session.hasRecoveredDraft;
  return (
    <div ref={surfaceRootRef} className={styles.surface}>
      {recovery ? (
        <div
          className={styles.recovery}
          data-state={failed ? "failed" : "recovered"}
          role={failed ? "alert" : "status"}
          aria-live="polite"
        >
          <span>
            {failed
              ? "Changes are saved here until you retry."
              : "Recovered unsaved changes."}
          </span>
          <span className={styles.recoveryActions}>
            <Button size="sm" variant="secondary" onClick={session.retry}>
              Retry
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void session.reload()}
            >
              Reload
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void session.copyRecovery()}
            >
              Copy
            </Button>
          </span>
        </div>
      ) : null}
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <div className={styles.masthead}>{masthead}</div>
      <ResourceSurfaceBodyEditor
        sourceRef={surface?.source.item.ref}
        editorSessionKey={editorSessionKey}
        orderedItems={orderedItems}
        rowFilterQuery={rowFilterQuery}
        editable={editable}
        structuralEditing={
          surface !== null || Boolean(daily && orderedItems.length === 0)
        }
        focusRequest={bodyFocus}
        onInsertNote={insertNote}
        onSplitNote={splitNote}
        onMoveOccurrence={({ occurrenceId, position }) =>
          session.command({ type: "move_occurrence", occurrenceId, position })
        }
        onRemoveOccurrence={(occurrenceId) =>
          session.command({ type: "remove_occurrence", occurrenceId })
        }
        onInsertResource={({ targetRef, position }) =>
          session.command({ type: "insert_resource", targetRef, position })
        }
        onBodyChange={(change) => session.updateBody(change)}
        onBodyBlur={(change) => session.updateBody({ ...change, flush: true })}
        onActivate={activate}
        onOpenObject={openObject}
        onFeedback={setFeedback}
        inputHandoff={
          dailyDraft && dailySession?.inputHandoff.kind === "Buffered"
            ? {
                noteRef: draftNoteRef(dailyDraft.noteId),
                handoff: dailySession.inputHandoff,
              }
            : null
        }
        onInputHandoffClaimed={dailySession?.acknowledgeInputHandoff}
        onError={(error) =>
          setFeedback(
            toFeedback(error, {
              fallback: "This surface could not be edited.",
            }),
          )
        }
      />
    </div>
  );
}
