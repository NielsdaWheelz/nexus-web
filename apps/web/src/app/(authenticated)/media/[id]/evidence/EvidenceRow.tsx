"use client";

// One evidence fact: a highlight (its note, edited here), a source note with
// its targets' text, a citation or a link. Removal follows its owning command.
import { useEffect, useRef, useState } from "react";
import { ExternalLink, LocateFixed, MessageSquare } from "lucide-react";
import HtmlRenderer from "@/components/HtmlRenderer";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import MachineText from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { connectionMutationAction, connectionMutationErrorMessage, mutateConnection, type ConnectionMutation } from "@/lib/resourceGraph/connectionMutations";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import ConnectionCreation from "@/components/connections/ConnectionCreation";
import type { ResourceActivation } from "@/lib/resources/activation";
import { fetchResourceSurface } from "@/lib/resourceSurface/api";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
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

function ObjectActions({
  object,
  actions,
  remove,
  onChanged,
}: {
  readonly object: EvidenceObject;
  readonly actions: EvidenceActions;
  readonly remove?: { readonly edgeId: string; readonly mutation: ConnectionMutation };
  readonly onChanged: () => void;
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
          action={connectionMutationAction(remove.mutation)}
          retryable
          label={`Edit connection ${object.label}`}
          execute={async () => {
            await mutateConnection(remove.edgeId, remove.mutation);
            onChanged();
          }}
          presentFailure={connectionMutationErrorMessage}
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
  const currentNote = useRef(note);
  currentNote.current = note;
  const [retry, setRetry] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (!noteBlockId) return;
    // A save already supplied this exact body and versions. Keep its editor
    // mounted so an unsaved successor remains in the same writing session.
    if (typeof currentNote.current === "object" && currentNote.current?.note_block_id === noteBlockId) return;
    let live = true;
    setNote("loading");
    void fetchResourceSurface(`note_block:${noteBlockId}`).then(
      ({ source }) => {
        if (!live) return;
        if (source.item.ref !== `note_block:${noteBlockId}` || source.content.kind !== "note_body") {
          // justify-defect: a note surface projects the requested note body.
          throw new TypeError("Link note surface has the wrong identity or content");
        }
        const { body, links } = source.item.versionByLane;
        if (body === undefined || links === undefined) {
          // justify-defect: an editable note exposes both owned version lanes.
          throw new TypeError("Link note surface is missing note versions");
        }
        setNote({
          note_block_id: noteBlockId,
          body_pm_json: source.content.bodyPmJson,
          body_text: source.content.bodyText,
          version_by_lane: { body, links },
        });
      },
    ).catch((error: unknown) => {
      if (!live || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) { setDefect({ error }); return; }
      setNote("failed");
    });
    return () => {
      live = false;
    };
  }, [noteBlockId, retry]);
  if (defect) throw defect.error;
  const { verbs } = actions;
  return (
    <div className={styles.noteEditor}>
      {note === "loading" ? (
        <p role="status">Loading note…</p>
      ) : note === "failed" ? (
        <div role="alert">The note couldn’t be loaded. <button type="button" className={styles.textButton} onClick={() => setRetry((value) => value + 1)}>Retry</button></div>
      ) : (
        <HighlightNoteEditor
          target={{ ...target, ownerKey: `${target.kind}:${target.id}` }}
          note={note}
          editable
          onEditAccepted={target.kind === "highlight" ? verbs.noteAccepted : undefined}
          onMutationStarted={target.kind === "highlight" ? verbs.noteMutation : undefined}
          onSaved={(_targetId, saved) => { setNote(saved); actions.refresh(); }}
          onDetached={() => { setNote(null); actions.refresh(); }}
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
  onConnectionChanged,
}: {
  readonly item: EvidenceItem;
  readonly actions: EvidenceActions;
  readonly active: boolean;
  readonly onConnectionChanged: (row: HTMLElement | null) => void;
}) {
  const { verbs } = actions;
  const row = useRef<HTMLElement>(null);
  const [linkNote, setLinkNote] = useState(false);
  const [associations, setAssociations] = useState(false);
  const [expandedSources, setExpandedSources] = useState<ReadonlySet<string>>(new Set());
  const highlight = item.kind === "Highlight" ? item : null;
  const notes = item.associations.flatMap((a) =>
    a.relationship === "DirectlyAttached" && a.origin === "highlight_note" && a.object.kind === "Note"
      ? [a.object]
      : [],
  );
  const editing = highlight !== null && verbs.noteEdit?.kind === "highlight" && verbs.noteEdit.id === highlight.highlight_id;
  const editingLink = item.kind === "Link" && (linkNote || (verbs.noteEdit?.kind === "link" && verbs.noteEdit.id === item.edge_id));
  const kind =
    item.kind === "SourceReference"
      ? item.apparatus_kind.startsWith("bibliography") ? "Source citation" : "Source note"
      : item.kind === "GeneratedCitation" ? "Cited by" : item.kind === "MachineLink" ? "Machine-created link" : item.kind;
  const editor = (target: { kind: "highlight" | "link"; id: string }, note: string | null, done: () => void) => (
    <NoteEditorHost
      key={`${target.kind}:${target.id}`}
      target={target}
      noteBlockId={note}
      actions={actions}
      done={done}
    />
  );

  return (
    <article
      ref={row}
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
        {item.kind === "Link" || item.kind === "MachineLink" ? (
          <ObjectActions
            object={item.object}
            actions={actions}
            onChanged={() => onConnectionChanged(row.current)}
            remove={item.mutation ? { edgeId: item.edge_id, mutation: item.mutation } : undefined}
          />
        ) : null}
        {item.kind === "Link" && item.origin === "user" && item.role === "context" ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-pressed={editingLink}
            aria-label={`Note on link ${item.label}`}
            onClick={() => { if (editingLink) { setLinkNote(false); verbs.closeNoteEdit(); } else setLinkNote(true); }}
          >
            <MessageSquare size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className={styles.itemLabel}>{highlight ? highlight.quote : item.label}</p>
      {item.kind === "MachineLink" && item.rationale ? (
        <MachineText variant="inline" origin={{ label: item.origin === "discovery" ? "Connection discovery" : "Assistant" }}>
          {item.rationale}
        </MachineText>
      ) : item.kind !== "SourceReference" && !highlight && item.excerpt.kind === "Present" && item.excerpt.value !== item.label ? (
        <p className={styles.excerpt}>{item.excerpt.value}</p>
      ) : null}
      {"creation" in item && item.creation ? <ConnectionCreation creation={item.creation} /> : null}
      {"mutation" in item && item.mutation?.kind === "dismiss_discovery" ? <p className={styles.kind}>Dismissing hides this link and prevents rediscovery of this pair.</p> : null}
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
      {editingLink && item.kind === "Link"
        ? editor({ kind: "link", id: item.edge_id }, item.link_note?.note_block_id ?? null, () => { setLinkNote(false); verbs.closeNoteEdit(); })
        : null}
      {item.kind === "SourceReference"
        ? item.target_refs.map((ref) => {
            const target = actions.sources.get(ref)!;
            const name = target.label.kind === "Present" ? target.label.value : null;
            const text = target.content.kind === "Unavailable" ? null : target.content.text;
            const expandable = text !== null && text.length > 240;
            const expanded = expandedSources.has(ref);
            return (
              <section key={ref} className={styles.source} aria-label={`${KIND[target.apparatus_kind]} ${name ?? ""}`.trim()}>
                {expandable && !expanded ? <p>{text.slice(0, 240).trimEnd()}…</p> : target.content.kind === "Html" ? (
                  <HtmlRenderer htmlSanitized={target.content.html_sanitized} />
                ) : (
                  <p>{target.content.kind === "Text" ? target.content.text : "Note text unavailable."}</p>
                )}
                {expandable ? <button type="button" className={styles.textButton} aria-expanded={expanded} onClick={() => setExpandedSources((current) => {
                  const next = new Set(current);
                  if (!next.delete(ref)) next.add(ref);
                  return next;
                })}>{expanded ? "Collapse note" : "Read full note"}</button> : null}
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
                onChanged={() => onConnectionChanged(row.current)}
                remove={a.relationship === "DirectlyAttached" && a.mutation ? { edgeId: a.edge_id, mutation: a.mutation } : undefined}
              />
              {a.relationship === "DirectlyAttached" && a.creation ? <ConnectionCreation creation={a.creation} /> : null}
            </div>
          ))
        : null}
    </article>
  );
}
