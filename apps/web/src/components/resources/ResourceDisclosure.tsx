"use client";

// Exact adjacency has one bounded reader. Supplied branches use their owner's read;
// the composer owns only unfinished input and never autosaves a reference query.
import NoteEditor from "@/components/notes/NoteEditor";
import { useContext } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";
import { emptyBody, bodyHasContent, type NoteBody } from "@/lib/notes/noteBody";
import { nudgeWrites, useWriteStatus } from "@/lib/notes/writes";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import {
  insertNote,
  endpointForResource,
  type InsertionSource,
} from "@/lib/resourceGraph/links";
import { useResourceOutline } from "@/lib/resourceGraph/useResourceOutline";
import { classifyOutlineOccurrence } from "@/lib/resources/outlineProjection";
import ResourceOutlineList, {
  ResourceBranch,
  ResourceOutlineContext,
} from "./ResourceOutlineList";
import ResourceOutlineRow from "./ResourceOutlineRow";
import styles from "./ResourceOutline.module.css";

export default function ResourceDisclosure({
  resourceRef,
  occurrencePrefix,
  supplied,
  readOnly = false,
  embeddedInNoteRef = null,
}: {
  resourceRef: string;
  occurrencePrefix: string;
  supplied?: Schema<"OutlineOut"> | null;
  readOnly?: boolean;
  embeddedInNoteRef?: string | null;
}) {
  const read = useResourceOutline(resourceRef, supplied);
  const branch = useContext(ResourceBranch);
  const focus = useContext(ResourceOutlineContext)?.view.focused ?? null;
  const showFeedback =
    focus === null ||
    occurrencePrefix === focus ||
    occurrencePrefix.startsWith(`${focus}/`);
  const items = read.items.filter(
    ({ connection }) =>
      classifyOutlineOccurrence({
        branch,
        targetRef: connection.other.ref,
        edgeId: connection.edge_id,
      }).kind !== "omit" &&
      !(
        embeddedInNoteRef !== null &&
        connection.origin === "note_body" &&
        connection.kind === "context" &&
        connection.ordinal === null &&
        connection.source.ref === embeddedInNoteRef &&
        connection.target.ref === resourceRef
      ),
  );
  const source = readOnly ? null : endpointForResource(resourceRef);
  return (
    <>
      {showFeedback && read.status === "loading" ? (
        <p role="status" className={styles.status}>
          loading linked resources…
        </p>
      ) : null}
      {showFeedback && read.error ? (
        <p role="alert" className={styles.status}>
          couldn’t refresh connections{" "}
          <button
            type="button"
            className={styles.textButton}
            onClick={read.retry}
          >
            retry refresh
          </button>
        </p>
      ) : null}
      <ResourceOutlineList
        scope={`${occurrencePrefix}/links`}
        ariaLabel="linked resources"
        ancestorRef={resourceRef}
        busy={read.status === "loading"}
      >
        {items.map(({ connection, content }) => (
          <ResourceOutlineRow
            key={connection.edge_id}
            item={connection.other}
            occurrenceKey={`${occurrencePrefix}/${connection.edge_id}`}
            connection={connection} incoming={{ kind: "edge", edge_id: connection.edge_id, origin: connection.origin, mutation: connection.mutation, creation: connection.creation }}
            historical={
              content.kind === "resource" &&
              connection.ordinal !== null &&
              connection.other.ref === connection.target.ref
            }
            onChanged={read.refetch}
          />
        ))}
      </ResourceOutlineList>
      {showFeedback &&
      read.status === "ready" &&
      read.complete &&
      items.length === 0 ? (
        <p className={styles.status}>no linked resources</p>
      ) : null}
      {showFeedback && !read.complete && read.status === "ready" ? (
        <button type="button" className={styles.textButton} onClick={read.more}>
          show more
        </button>
      ) : null}
      {showFeedback && source ? (
        <ResourceComposer
          source={source}
          occurrenceKey={occurrencePrefix}
          label="add item"
          onSaved={read.refetch}
        />
      ) : null}
    </>
  );
}

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

export function ResourceComposer({
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
    } catch {
      // The queue rejects only terminal failures: unsent build failures or
      // definitive refusals. Unconfirmed writes keep these exact ids and source.
      draft.set((value) => ({
        ...value,
        intent: null,
        pending: false,
        failure: "couldn’t save this item; correct the draft and try again",
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
        editable={!pending}
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
