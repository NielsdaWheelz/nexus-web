"use client";

// A resource-owned unfinished input. Canonical graph commands own confirmed items.
import NoteEditor from "@/components/notes/NoteEditor";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { emptyBody, bodyHasContent, type NoteBody } from "@/lib/notes/noteBody";
import { isWriteRejection, nudgeWrites, useWriteStatus } from "@/lib/notes/writes";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { insertNote, type InsertionSource } from "@/lib/resourceGraph/links";
import styles from "./ResourceOutline.module.css";

type ComposerDraft = {
  body: NoteBody;
  revision: number;
  searching: boolean;
  pending: boolean;
  failure: string | null;
  intent: {
    source: InsertionSource;
    link_id: string;
    note_id: string;
    body_pm_json: NoteBody["body_pm_json"];
  } | null;
};

export default function ResourceComposer({
  source,
  occurrenceKey,
  label,
  onSaved,
  onActiveChange,
}: {
  source: InsertionSource;
  occurrenceKey: string;
  label: string;
  onSaved?: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const draft = useResourceDraft<ComposerDraft>(
    `Resources.ItemDraft:${occurrenceKey}`,
    () => ({
      body: emptyBody(),
      revision: 0,
      searching: false,
      pending: false,
      failure: null,
      intent: null,
    }),
    value => ({ changed: bodyHasContent(value.body), unconfirmed: value.pending, stopsBrowserWork: false }),
  );
  const { body, revision, searching, pending, failure } = draft.value;
  const writeStatus = useWriteStatus();
  async function save() {
    const current = draft.read();
    if (current.pending || current.searching || !bodyHasContent(current.body))
      return;
    const frozen = current.intent ?? {
      source: structuredClone(source),
      link_id: crypto.randomUUID(),
      note_id: crypto.randomUUID(),
      body_pm_json: structuredClone(current.body.body_pm_json),
    };
    draft.set({ ...current, intent: frozen, pending: true, failure: null });
    try {
      await insertNote({ ...frozen, position: null });
    } catch (error) {
      // A refusal changed nothing: the draft is corrected and saved afresh. An answer the
      // queue reported as a defect may have landed: these exact ids are resent.
      const refused = isWriteRejection(error);
      draft.set((value) => ({
        ...value,
        intent: refused ? null : value.intent,
        pending: false,
        failure: refused
          ? "couldn’t save this item; correct the draft and try again"
          : "couldn’t confirm this item; save note resends the same request",
      }));
      return;
    }
    draft.set((value) => ({
      ...value,
      body: emptyBody(),
      revision: value.revision + 1,
      intent: null,
      pending: false,
      failure: null,
    }));
    onSaved?.();
  }
  return (
    <div className={styles.composer}>
      {source.kind === "resource" && source.ref.startsWith("conversation:") ? (
        <p className={styles.status}>
          linked items supply context to future turns in this conversation
        </p>
      ) : null}
      <NoteEditor
        editorKey={`resource-composer:${occurrenceKey}`}
        body={body}
        revision={revision}
        label={label}
        history={null}
        containingNoteRef={null}
        editable={draft.value.intent === null}
        reference={{
          source,
          label,
          position: null,
          onActiveChange: (active) => {
            draft.set((value) => ({ ...value, searching: active }));
            onActiveChange?.(active);
          },
          onInserted: () => {
            draft.set((value) => ({
              ...value,
              body: emptyBody(),
              revision: value.revision + 1,
              searching: false,
            }));
            onActiveChange?.(false);
            onSaved?.();
          },
        }}
        onEdit={(edit) =>
          draft.set((value) => ({ ...value, body: edit.after }))
        }
      />
      <button
        className={styles.textButton}
        type="button"
        onClick={() => void save()}
        disabled={pending || searching || !bodyHasContent(body)}
      >
        {pending ? "saving…" : "save note"}
      </button>
      {pending && writeStatus === "retrying" ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "waiting for a pending write to be confirmed",
            message:
              "your draft is kept; retry resends the same pending request",
          }}
          announcement="Polite"
          actions={[{ label: "retry pending request", onClick: nudgeWrites }]}
        />
      ) : null}
      {failure ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: failure }}
          announcement="Assertive"
        />
      ) : null}
    </div>
  );
}

/** A mounted root owns its source and exposes this local action to pane chrome. */
export function useResourceComposer(
  source: InsertionSource | null,
  occurrenceKey: string,
  label: string,
) {
  const opened = useResourceDraft<boolean>(
    `Resources.RootComposer:${occurrenceKey}`,
    () => false,
  );
  const action =
    source === null
      ? null
      : {
          kind: "command" as const,
          id: "Resource.AddItem",
          label: "add item",
          onSelect: () => opened.set(true),
        };
  return {
    action,
    content:
      opened.value && source ? (
        <ResourceComposer
          source={source}
          occurrenceKey={occurrenceKey}
          label={label}
        />
      ) : null,
  };
}
