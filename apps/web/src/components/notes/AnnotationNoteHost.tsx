"use client";

// One annotation occurrence retains its first-save id. Canonical texts own its
// body and acknowledgement, including a save that settles while this is unmounted.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import AnnotationNoteEditor, {
  type AnnotationTarget,
} from "./AnnotationNoteEditor";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import {
  OutlineSessionContext,
  ResourceBranch,
} from "@/components/resources/ResourceOutlineList";
import { resourceOccurrenceKey } from "@/lib/notes/outline";
import type { OutlineBranch } from "@/lib/resources/outlineProjection";
import { bodyHasContent } from "@/lib/notes/noteBody";
import { readTextTitle, textCreationReady, useText } from "@/lib/notes/texts";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import {
  isDeletedResource,
  subscribeLinkMutations,
} from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import styles from "@/components/resources/ResourceOutline.module.css";

export default function AnnotationNoteHost({
  target,
  noteRef,
  occurrenceKey,
  focusRequest,
  onActivate,
  onChanged,
  onClose,
  label,
  completeAnnotation = null,
  editable = true,
  atomicEmbeds = false,
  showItemsLabel = false,
}: {
  target: AnnotationTarget;
  noteRef: string | null;
  occurrenceKey: string;
  focusRequest: number;
  onActivate?: () => void;
  onChanged: () => void;
  onClose: () => void;
  label?: string;
  completeAnnotation?: Schema<"ResourceAnnotationOut"> | null;
  editable?: boolean;
  atomicEmbeds?: boolean;
  showItemsLabel?: boolean;
}) {
  const session = useContext(OutlineSessionContext);
  const inherited = useContext(ResourceBranch);
  const expanded = useResourceDraft(
    `Annotations.Children:${occurrenceKey}`,
    () => false,
  );
  const {
    value: draft,
    set: setDraft,
    read: readDraft,
  } = useResourceDraft(`Annotations.Note:${occurrenceKey}`, () => ({
    noteId: noteRef?.slice("note_block:".length) ?? crypto.randomUUID(),
    attachmentRef: noteRef,
  }));
  const retainedRef = `note_block:${draft.noteId}`;
  const retainedText = useText(retainedRef);
  // A competing first create must not replace the draft whose write will report
  // the slot conflict. Canonical text ownership already knows its settlement.
  const keepDraft =
    noteRef !== null &&
    noteRef !== retainedRef &&
    retainedText !== undefined &&
    typeof retainedText.value !== "string" &&
    (bodyHasContent(retainedText.value) || retainedText.creationIntent) &&
    readTextTitle(retainedRef)?.unsettled === true;
  const changedAttachment = noteRef !== draft.attachmentRef && !keepDraft;
  const noteId =
    changedAttachment && noteRef !== null
      ? noteRef.slice("note_block:".length)
      : draft.noteId;
  const ref = `note_block:${noteId}`;
  const removedAttachment = noteRef === null && draft.attachmentRef === ref;
  const text = useText(ref);
  const root = useRef<HTMLDivElement>(null);
  const paneActive = usePaneIsActive();
  const close = () => {
    if (session?.activeReference?.startsWith(`${occurrenceKey}/annotation/`))
      return;
    const ownsFocus = root.current?.contains(document.activeElement) ?? false;
    const row = root.current?.closest("[data-outline-occurrence]");
    const control = row?.querySelector<HTMLElement>(
      "[data-row-focusable]:not(:disabled)",
    );
    onClose();
    if (ownsFocus && control?.isConnected)
      control.focus({ preventScroll: true });
  };
  const currentClose = useRef(close);
  currentClose.current = close;
  const deleted = isDeletedResource(ref);
  const attachedRef = noteRef === ref ? noteRef : null;
  const fullSeed =
    completeAnnotation?.note_ref === ref ? completeAnnotation : null;
  const bodyKey = resourceOccurrenceKey(`${occurrenceKey}/annotation`, ref);
  const consumedFocus = useRef<number | null>(null);
  const focusRow = session?.focusRow;
  const activeReference = session?.activeReference;
  // The host owns activation before a cold body read can mount its editor.
  useLayoutEffect(() => {
    if (consumedFocus.current === focusRequest) return;
    consumedFocus.current = focusRequest;
    if (
      focusRequest > 0 &&
      !atomicEmbeds &&
      focusRow &&
      (activeReference == null || activeReference === bodyKey)
    )
      focusRow(bodyKey, "end");
  }, [focusRequest, bodyKey, atomicEmbeds, focusRow, activeReference]);

  const read = usePaneFreeServerValue<Schema<"NoteBlockOut">>({
    key:
      !deleted && fullSeed === null && attachedRef !== null
        ? `annotation-note:${attachedRef}`
        : null,
    stale: "",
    load: async (signal) =>
      (
        await apiFetch<ApiJson<"/notes/blocks/{note_id}", "get">>(
          `/api/notes/blocks/${noteId}`,
          { signal },
        )
      ).data,
  });

  useEffect(() => {
    if (!changedAttachment) return;
    setDraft({
      noteId: removedAttachment ? crypto.randomUUID() : noteId,
      attachmentRef: noteRef,
    });
    if (removedAttachment) currentClose.current();
  }, [changedAttachment, removedAttachment, setDraft, noteId, noteRef]);
  useEffect(() => {
    const closeDeleted = () => {
      if (isDeletedResource(ref)) currentClose.current();
    };
    closeDeleted();
    return subscribeLinkMutations((change) => {
      if (change.kind === "resource_deleted") closeDeleted();
    });
  }, [ref]);

  const loaded =
    fullSeed ??
    (read.status === "ready" && attachedRef !== null ? read.data : null);
  const branch = useMemo<OutlineBranch>(
    () => ({
      ancestors: inherited.ancestors.has(ref)
        ? inherited.ancestors
        : new Map(inherited.ancestors).set(ref, {
            kind: "occurrence",
            key: bodyKey,
          }),
      traversedEdgeIds:
        fullSeed === null
          ? inherited.traversedEdgeIds
          : new Set([
              ...inherited.traversedEdgeIds,
              fullSeed.attachment_edge_id,
            ]),
    }),
    [inherited, ref, bodyKey, fullSeed],
  );
  useLayoutEffect(() => {
    if (!expanded.value && session?.focus?.key.startsWith(`${bodyKey}/`))
      expanded.set(true);
  }, [expanded, session?.focus, bodyKey]);
  const note = useMemo<Schema<"LinkedNoteBlockRef"> | null>(
    () =>
      loaded === null
        ? null
        : {
            note_block_id: noteId,
            body_pm_json: loaded.body_pm_json,
            body_text: loaded.body_text,
            body_version: loaded.body_version,
            embedded_item:
              "embedded_item" in loaded ? loaded.embedded_item : null,
          },
    [loaded, noteId],
  );
  if (deleted) return null;
  return (
    <ResourceBranch value={branch}>
      <div className={styles.annotation} ref={root} tabIndex={-1}>
        {note === null && text?.acked == null && attachedRef !== null ? (
          read.status === "failed" ? (
            <FeedbackNotice
              content={{
                tone: "Danger",
                title: "couldn’t load the note",
                requestId: read.error.requestId,
              }}
              announcement={paneActive ? "Polite" : "None"}
              actions={[
                { label: "retry", onClick: read.refetch, busy: read.retrying },
              ]}
              returnFocus={() =>
                root.current?.querySelector<HTMLElement>(
                  "[contenteditable=true]",
                ) ?? root.current
              }
            />
          ) : (
            <FeedbackStatus
              content={{ tone: "Neutral", title: "loading note…" }}
              announcement={paneActive ? "Polite" : "None"}
            />
          )
        ) : (
          <div
            onClick={(event) => {
              const target = event.target;
              if (
                !atomicEmbeds &&
                target instanceof Element &&
                !target.closest("button, a") &&
                target
                  .closest("[data-outline-occurrence]")
                  ?.getAttribute("data-outline-occurrence") === bodyKey
              )
                onActivate?.();
            }}
          >
            <AnnotationNoteEditor
              key={noteId}
              target={target}
              noteId={noteId}
              note={note}
              editable={editable}
              atomicEmbeds={atomicEmbeds}
              occurrenceKey={bodyKey}
              label={label}
              onSaved={onChanged}
              onDetached={() => {
                if (readDraft().noteId === noteId) {
                  setDraft({
                    noteId: crypto.randomUUID(),
                    attachmentRef: noteRef,
                  });
                  close();
                }
                onChanged();
              }}
            />
          </div>
        )}
        {target.kind === "highlight" && !atomicEmbeds && session ? (
          <button
            type="button"
            className={styles.textButton}
            disabled={
              text === undefined ||
              typeof text.value === "string" ||
              !textCreationReady(ref) ||
              session.activeReference !== null
            }
            onClick={() => {
              if (
                !text ||
                typeof text.value === "string" ||
                !textCreationReady(ref) ||
                session.activeReference !== null
              )
                return;
              expanded.set(true);
              void session.insertNote({
                destination: {
                  source: { kind: "resource", ref },
                  position: null,
                  occurrencePrefix: bodyKey,
                  path: [],
                },
                body: { body_pm_json: { type: "paragraph" }, body_text: "" },
                ...(text.acked === null
                  ? { creator: { noteRef: ref, base: text.value } }
                  : {}),
              });
            }}
          >
            add item to annotation
          </button>
        ) : null}
        {target.kind === "highlight" &&
        expanded.value &&
        session &&
        !atomicEmbeds &&
        (text?.acked != null || note !== null) ? (
          <section aria-label="annotation items">
            {showItemsLabel ? (
              <p className={styles.quiet}>annotation items</p>
            ) : null}
            <ResourceDisclosure
              resourceRef={ref}
              occurrencePrefix={bodyKey}
              readOnly={atomicEmbeds}
              suppressedEdgeIds={fullSeed ? [fullSeed.attachment_edge_id] : []}
            />
          </section>
        ) : null}
        {target.kind === "link" || editable ? (
          <button
            type="button"
            className={styles.textButton}
            disabled={session?.activeReference?.startsWith(bodyKey)}
            onClick={close}
          >
            done editing note
          </button>
        ) : null}
      </div>
    </ResourceBranch>
  );
}
