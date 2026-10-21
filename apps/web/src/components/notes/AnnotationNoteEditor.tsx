"use client";

// an attached body shares the canonical text owner. its first edit publishes with
// fixed attachment ids and the captured slot fence; opening never submits work.
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import CanonicalNoteEditor from "./CanonicalNoteEditor";
import { OutlineSessionContext, OutlineSessionScope, ResourceBranch } from "@/components/resources/ResourceOutlineList";
import { useOutlineSession, type OutlineSession } from "@/lib/notes/useOutlineSession";
import { WritingStatus, useWriting } from "./NoteNotices";
import Button from "@/components/ui/Button";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { emptyBody } from "@/lib/notes/noteBody";
import { adoptText, createText, readText, setCreator, snapshotText, textDraft, useText } from "@/lib/notes/texts";
import { admitWriting, assertWritingRuntimeToken, readDraft, writingRuntimeToken, type Publication } from "@/lib/notes/journal";
import styles from "./AnnotationNoteEditor.module.css";

type AttachedNote = Schema<"LinkedNoteBlockRef">;
export type AnnotationTarget =
  | { readonly kind: "highlight"; readonly id: string }
  | { readonly kind: "link"; readonly id: string; readonly sourceRef: string };
export type AnnotationAttachment =
  | { readonly kind: "highlight"; readonly linkId: string }
  | { readonly kind: "link"; readonly sourceLinkId: string; readonly targetLinkId: string };
export interface AnnotationNoteEditorProps {
  target: AnnotationTarget;
  attachment: AnnotationAttachment;
  noteId: string;
  note: AttachedNote | null;
  attachmentRemoved: boolean;
  editable: boolean;
  onSaved: (targetId: string, note: AttachedNote) => void;
  onDetached: (targetId: string, noteBlockId: string, intentId: string, phase: "pending" | "confirmed" | "failed") => void;
  occurrenceKey?: string;
  label?: string;
  atomicEmbeds?: boolean;
}

export default function AnnotationNoteEditor(props: AnnotationNoteEditorProps) {
  const session = useContext(OutlineSessionContext);
  return session ? <SessionAnnotationEditor {...props} session={session} /> : <StandaloneAnnotationEditor {...props} />;
}
function StandaloneAnnotationEditor(props: AnnotationNoteEditorProps) {
  const branch = useContext(ResourceBranch);
  const session = useOutlineSession({ scope: props.occurrenceKey ?? `annotation:${props.target.kind}:${props.target.id}:${props.noteId}`, inheritedBranch: branch });
  return <OutlineSessionScope session={session}><SessionAnnotationEditor {...props} session={session} /></OutlineSessionScope>;
}
function SessionAnnotationEditor(props: AnnotationNoteEditorProps & { session: OutlineSession }) {
  const { target, attachment, noteId, note, editable } = props;
  const feedback = useFeedback();
  const writing = useWriting();
  const ref = `note_block:${noteId}`;
  const [detaching, setDetaching] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const latest = useRef(props);
  latest.current = props;
  const text = useText(ref);
  const attached = !props.attachmentRemoved && (note !== null || text?.acked != null);
  const referencing = props.session.activeReference === (props.occurrenceKey ?? ref);
  const versionRef = target.kind === "highlight" ? `highlight:${target.id}` : target.sourceRef;
  const slot = usePaneFreeServerValue<Schema<"ResourceVersionState">>({
    key: attached || props.attachmentRemoved ? null : `annotation-slot:${versionRef}`,
    stale: "",
    load: async signal => {
      const { data } = await apiFetch<ApiJson<"/resource-graph/versions/query", "post">>("/api/resource-graph/versions/query", {
        method: "POST", body: JSON.stringify({ refs: [versionRef] }), signal,
      });
      const source = data.items.find(item => item.ref === versionRef);
      if (!source || source.state !== "live" || source.links_version === null) throw new Error("the attachment source is unavailable");
      return source;
    },
  });
  const linksVersion = slot.status === "ready" ? slot.data.links_version : null;
  const publication = useMemo<Extract<Publication, { kind: "attach_highlight" | "attach_link" }> | null>(() => {
    if (linksVersion === null) return null;
    if (target.kind === "highlight" && attachment.kind === "highlight") return {
      kind: "attach_highlight", highlight_id: target.id, request: { note_id: noteId, link_id: attachment.linkId,
        body_pm_json: emptyBody().body_pm_json, expected: { kind: "absent", version: linksVersion } },
    };
    if (target.kind !== "link" || attachment.kind !== "link") throw new Error("annotation target and attachment disagree");
    return { kind: "attach_link", link_id: target.id, request: { note_id: noteId,
      source_link_id: attachment.sourceLinkId, target_link_id: attachment.targetLinkId, body_pm_json: emptyBody().body_pm_json,
      expected: { kind: "absent", source_ref: versionRef, links_version: linksVersion } } };
  }, [attachment, linksVersion, noteId, target.id, target.kind, versionRef]);
  useEffect(() => {
    if (note) adoptText(ref, { body_pm_json: note.body_pm_json, body_text: note.body_text }, note.body_version);
    else if (!readText(ref)) createText(ref, emptyBody(), null);
  }, [note, ref]);
  useEffect(() => {
    if (attached || props.attachmentRemoved || publication === null || !readText(ref)) return;
    const handle = textDraft(ref);
    const context = handle && readDraft(handle.draft_id)?.context;
    // restored writing keeps its original fence and publication policy.
    if (context?.kind === "body" && context.publication !== null) return;
    setCreator(ref, publication);
  }, [attached, props.attachmentRemoved, publication, ref]);

  const version = text?.acked?.version ?? null;
  const reported = useRef(note?.body_version ?? null);
  useEffect(() => {
    if (version === null || reported.current === version || !text?.acked || typeof text.acked.value === "string") return;
    reported.current = version;
    latest.current.onSaved(target.id, {
      note_block_id: noteId, link_id: attachment.kind === "highlight" ? attachment.linkId : attachment.sourceLinkId,
      ...text.acked.value, body_version: version, embedded_item: note?.embedded_item ?? null,
    });
  }, [attachment, note?.embedded_item, noteId, target.id, text, version]);

  const detach = async () => {
    if (detaching || writing.paused || !text?.ready) return;
    const token = writingRuntimeToken();
    const owner = props.onDetached;
    const failed = (error: unknown) => {
      if (!mounted.current || latest.current.noteId !== noteId || handleUnauthenticatedApiError(error)) return;
      const title = target.kind === "link" ? "note wasn’t removed from link" : "annotation wasn’t removed";
      feedback.offer({ key: "annotation-note", announcement: "Polite", content: isApiError(error) && apiTransportFeedback(error, title) || {
        tone: "Danger", title, message: "your writing is kept. review the attachment before trying again.",
      } });
    };
    setDetaching(true);
    try {
      const intent = target.kind === "highlight" && attachment.kind === "highlight"
        ? { kind: "detach_highlight" as const, highlight_id: target.id, note_id: noteId, link_id: attachment.linkId }
        : target.kind === "link" && attachment.kind === "link"
          ? { kind: "detach_link" as const, link_id: target.id, note_id: noteId, source_link_id: attachment.sourceLinkId, target_link_id: attachment.targetLinkId }
          : null;
      if (intent === null) throw new Error("annotation target and attachment disagree");
      const admitted = admitWriting(intent, snapshotText(ref).then(snapshot => [snapshot]));
      void admitted.settled.then(ack => {
        assertWritingRuntimeToken(token);
        for (const note of ack.notes) adoptText(`note_block:${note.id}`, { body_pm_json: note.body_pm_json, body_text: note.body_text }, note.body_version);
        owner(target.id, noteId, admitted.intent_id, "confirmed");
      }, error => {
        assertWritingRuntimeToken(token);
        owner(target.id, noteId, admitted.intent_id, "failed");
        failed(error);
      }).catch(() => undefined);
      await admitted.durable;
      assertWritingRuntimeToken(token);
      owner(target.id, noteId, admitted.intent_id, "pending");
    } catch (error) { failed(error); }
    finally { if (mounted.current) setDetaching(false); }
  };

  if (!text || typeof text.value === "string") return null;
  return <div className={styles.shell} data-editable={editable ? "true" : "false"}>
    <CanonicalNoteEditor session={props.session} occurrence={{ key: props.occurrenceKey ?? ref, noteRef: ref }}
      continuation={target.kind === "highlight" ? { source: { kind: "resource", ref }, position: null,
        occurrencePrefix: props.occurrenceKey ?? ref, path: [] } : null}
      label={props.label ?? (target.kind === "highlight" ? "edit note: annotation" : "edit note: note on link")}
      editable={editable && !writing.paused} embeddedItem={note?.embedded_item ?? null} atomicEmbeds={props.atomicEmbeds} />
    {!attached && slot.status === "failed" ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t prepare this attachment",
      message: text.durable ? "your draft is saved on this device. retry to save it here." : "keep this tab open until your draft is saved on this device.", requestId: slot.error.requestId }}
      announcement="Polite" actions={[{ label: "retry attachment setup", onClick: slot.refetch, busy: slot.retrying }]} /> : null}
    <div className={styles.actions}>
      <WritingStatus textRef={ref} />
      {attached && editable ? <Button variant="ghost" size="sm" onClick={() => void detach()} disabled={detaching || referencing || writing.paused || !text.ready}>
        {target.kind === "link" ? "remove note from link" : "remove annotation"}
      </Button> : null}
    </div>
  </div>;
}
