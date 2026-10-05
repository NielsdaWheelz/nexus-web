"use client";

// One evidence fact: a highlight (its note, edited here), a source note with
// its targets' text, a citation, a link (with its note) or a synapse; its
// associations open their objects; a user link or synapse can be removed.
import { useEffect, useState } from "react";
import { ExternalLink, LocateFixed, MessageSquare } from "lucide-react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import HtmlRenderer from "@/components/HtmlRenderer";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import MachineText from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { deleteLink } from "@/lib/resourceGraph/links";
import { deleteStance } from "@/lib/resourceGraph/stances";
import type { ResourceActivation } from "@/lib/resources/activation";
import { fetchResourceSurface } from "@/lib/resourceSurface/api";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { dismissSynapseEdge } from "@/lib/synapse";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import type { AnnotationVerbs } from "../useAnnotationVerbs";
import styles from "../media.module.css";

export type EvidenceItem = Schema<"ReaderEvidencePassageGroupOut">["items"][number];
export type SourceTarget = Schema<"ReaderEvidenceSourceTargetOut">;
type EvidenceObject = Schema<"ReaderEvidenceDirectlyAttachedOut">["object"];

export interface EvidenceActions {
  readonly verbs: Pick<
    AnnotationVerbs,
    "noteEdit" | "hovered" | "hover" | "closeNoteEdit" | "noteAccepted" | "noteMutation"
  >;
  readonly sources: ReadonlyMap<string, SourceTarget>;
  readonly open: (
    activation: ResourceActivation,
    disposition: WorkspaceTargetDisposition,
    label: string,
  ) => void;
  readonly jumpToSource: (target: SourceTarget) => void;
  readonly refresh: () => void;
  readonly openLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}

const KIND: Record<string, string> = {
  footnote_ref: "Footnote",
  footnote: "Footnote",
  endnote_ref: "Endnote",
  endnote: "Endnote",
  bibliography_ref: "Reference",
  bibliography_entry: "Reference",
  sidenote_ref: "Sidenote",
  sidenote: "Sidenote",
  margin_note_ref: "Margin note",
  margin_note: "Margin note",
  reference_section: "References",
};

function failure(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return { tone: "Danger", title: "Connection wasn’t changed", requestId: error.requestId };
}

function ObjectActions({
  object,
  actions,
  remove,
}: {
  readonly object: EvidenceObject;
  readonly actions: EvidenceActions;
  readonly remove?: { readonly action: "Unlink" | "Dismiss"; readonly execute: () => Promise<void> };
}) {
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        disabled={object.activation.kind === "none"}
        aria-label={`Open ${object.label}`}
        onClick={(event) =>
          actions.open(object.activation, workspaceTargetClickIntent(event).disposition, object.label)
        }
      >
        <ExternalLink size={14} aria-hidden="true" />
      </button>
      <ResourceActionMenu
        actionSubject={{ ref: assumeCanonicalResourceRef(object.ref) }}
        label={`Actions for ${object.label}`}
      />
      {remove ? (
        <ContextEdgeMenu
          action={remove.action}
          label={`Edit connection ${object.label}`}
          execute={async () => {
            await remove.execute();
            actions.refresh();
          }}
          presentFailure={failure}
        />
      ) : null}
    </>
  );
}

/** The note editor over an annotation, its existing note loaded at its current versions. */
function NoteEditorHost({
  target,
  noteBlockId,
  actions,
  done,
}: {
  readonly target: { readonly kind: "highlight" | "link"; readonly id: string };
  readonly noteBlockId: string | null;
  readonly actions: EvidenceActions;
  readonly done: () => void;
}) {
  const [note, setNote] = useState<Schema<"LinkedNoteBlockRef"> | "loading" | "failed" | null>(
    noteBlockId ? "loading" : null,
  );
  useEffect(() => {
    if (!noteBlockId) return;
    let live = true;
    fetchResourceSurface(`note_block:${noteBlockId}`).then(
      ({ source }) => {
        if (!live || source.content.kind !== "note_body") return;
        const { body, links } = source.item.versionByLane;
        setNote({
          note_block_id: noteBlockId,
          body_pm_json: source.content.bodyPmJson,
          body_text: source.content.bodyText,
          version_by_lane: { body, links },
        });
      },
      () => live && setNote("failed"),
    );
    return () => {
      live = false;
    };
  }, [noteBlockId]);
  const { verbs } = actions;
  return (
    <div className={styles.noteEditor}>
      {note === "loading" ? (
        <p role="status">Loading note…</p>
      ) : note === "failed" ? (
        <p role="alert">The note couldn’t be loaded.</p>
      ) : (
        <HighlightNoteEditor
          target={{ ...target, ownerKey: `${target.kind}:${target.id}` }}
          note={note}
          editable
          onEditAccepted={target.kind === "highlight" ? verbs.noteAccepted : undefined}
          onMutationStarted={target.kind === "highlight" ? verbs.noteMutation : undefined}
          onSaved={actions.refresh}
          onDetached={actions.refresh}
          onOpenLink={actions.openLink}
        />
      )}
      <button type="button" className={styles.textButton} onClick={done}>
        Done editing note
      </button>
    </div>
  );
}

export default function EvidenceRow({
  item,
  actions,
  active,
}: {
  readonly item: EvidenceItem;
  readonly actions: EvidenceActions;
  readonly active: boolean;
}) {
  const { verbs } = actions;
  const [linkNote, setLinkNote] = useState(false);
  const [associations, setAssociations] = useState(false);
  const highlight = item.kind === "Highlight" ? item : null;
  const notes = item.associations.flatMap((a) =>
    a.relationship === "DirectlyAttached" && a.origin === "highlight_note" && a.object.kind === "Note"
      ? [a.object]
      : [],
  );
  const editing = highlight !== null && verbs.noteEdit?.highlightId === highlight.highlight_id;
  const kind =
    item.kind === "SourceReference"
      ? item.apparatus_kind.startsWith("bibliography") ? "Source citation" : "Source note"
      : item.kind === "GeneratedCitation" ? "Cited by" : item.kind;
  const editor = (target: { kind: "highlight" | "link"; id: string }, note: string | null, done: () => void) => (
    <NoteEditorHost
      target={target}
      noteBlockId={note}
      actions={actions}
      done={done}
    />
  );

  return (
    <article
      className={styles.item}
      data-active={active || undefined}
      data-hovered={(highlight && verbs.hovered === highlight.highlight_id) || undefined}
      onMouseEnter={() => highlight && verbs.hover(highlight.highlight_id)}
      onMouseLeave={() => highlight && verbs.hover(null)}
    >
      <div className={styles.itemHead}>
        <span className={styles.kind}>{kind}</span>
        {highlight ? (
          <ResourceActionMenu
            actionSubject={{ ref: assumeCanonicalResourceRef(`highlight:${highlight.highlight_id}`) }}
            label="Highlight actions"
          />
        ) : null}
        {item.kind === "Link" || item.kind === "Synapse" ? (
          <ObjectActions
            object={item.object}
            actions={actions}
            remove={
              item.kind === "Synapse"
                ? { action: "Dismiss", execute: () => dismissSynapseEdge(item.edge_id) }
                : item.origin === "user"
                  ? {
                      action: "Unlink",
                      execute: () =>
                        item.role === "context" ? deleteLink(item.edge_id) : deleteStance(item.edge_id),
                    }
                  : undefined
            }
          />
        ) : null}
        {item.kind === "Link" && item.origin === "user" && item.role === "context" ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-pressed={linkNote}
            aria-label={`Note on link ${item.label}`}
            onClick={() => setLinkNote(!linkNote)}
          >
            <MessageSquare size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className={styles.itemLabel}>{highlight ? highlight.quote : item.label}</p>
      {item.kind === "Synapse" ? (
        <MachineText variant="inline" origin={{ label: "Synapse" }}>
          {item.rationale}
        </MachineText>
      ) : item.kind !== "SourceReference" && !highlight && item.excerpt.kind === "Present" ? (
        <p className={styles.excerpt}>{item.excerpt.value}</p>
      ) : null}
      {highlight && !editing
        ? notes.map((note) => (
            <p key={note.note_block_id} className={styles.note}>
              {note.excerpt.kind === "Present" ? note.excerpt.value : ""}
            </p>
          ))
        : null}
      {editing && highlight
        ? editor({ kind: "highlight", id: highlight.highlight_id }, notes[0]?.note_block_id ?? null, verbs.closeNoteEdit)
        : null}
      {linkNote && item.kind === "Link"
        ? editor({ kind: "link", id: item.edge_id }, item.link_note?.note_block_id ?? null, () => setLinkNote(false))
        : null}
      {item.kind === "SourceReference"
        ? item.target_refs.map((ref) => {
            const target = actions.sources.get(ref)!;
            const name = target.label.kind === "Present" ? target.label.value : null;
            return (
              <section key={ref} className={styles.source} aria-label={`${KIND[target.apparatus_kind]} ${name ?? ""}`.trim()}>
                {target.content.kind === "Html" ? (
                  <HtmlRenderer htmlSanitized={target.content.html_sanitized} />
                ) : (
                  <p>{target.content.kind === "Text" ? target.content.text : "Note text unavailable."}</p>
                )}
                {target.resolution.kind === "Resolved" ? (
                  <button type="button" className={styles.textButton} onClick={() => actions.jumpToSource(target)}>
                    <LocateFixed size={12} aria-hidden="true" /> View in source
                  </button>
                ) : null}
              </section>
            );
          })
        : null}
      {item.associations.length > 0 ? (
        <button type="button" className={styles.textButton} aria-expanded={associations} onClick={() => setAssociations(!associations)}>
          {item.associations.length} linked {item.associations.length === 1 ? "object" : "objects"}
        </button>
      ) : null}
      {associations
        ? item.associations.map((a, index) => (
            <div key={index} className={styles.association}>
              <span>{a.relationship === "AuthoredIn" ? "Cited in" : "Attached directly"}</span>
              <span>{a.object.label}</span>
              <ObjectActions
                object={a.object}
                actions={actions}
                remove={
                  a.relationship === "DirectlyAttached" && a.origin === "user"
                    ? {
                        action: "Unlink",
                        execute: () => (a.role === "context" ? deleteLink(a.edge_id) : deleteStance(a.edge_id)),
                      }
                    : undefined
                }
              />
            </div>
          ))
        : null}
    </article>
  );
}
