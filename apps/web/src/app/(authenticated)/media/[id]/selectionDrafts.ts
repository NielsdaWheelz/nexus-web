import type { Schema } from "@/lib/api/wire";
import type { Passage } from "@/lib/documentReader/DocumentReader";
import { sameAnchor } from "@/lib/documentReader/anchors";
import type { Publication, WriteHandle } from "@/lib/notes/writes";
import type { NoteBodyHistory } from "@/lib/notes/bodyHistory";
import { emptyBody, parseBody, type NoteBody } from "@/lib/notes/noteBody";
import type { NoteEdit } from "@/lib/notes/useOutlineSession";
import type { ConversationCommands, ConversationTree } from "@/lib/chat/commands";
import type { Selection } from "@/lib/chat/wire";

export type NoteBase =
  | { kind: "Absent" }
  | { kind: "Present"; id: string; linkId: string; version: number; body: NoteBody; embeddedItem: Schema<"ResourceItemOut"> | null };

export type DraftIssue =
  | { kind: "Failed" | "Deleted" | "Source"; message: string }
  | { kind: "Conflict"; message: string; saved: NoteBase; linksVersion: number | null };

export type ChatDestination =
  | { kind: "Resolving" | "Absent" | "LookupFailed" }
  | { kind: "Selected"; id: string; title: string; read: number; snapshot:
      | { kind: "Loading" | "Failed" | "RefreshRequired" }
      | { kind: "Ready"; tree: ConversationTree } };

export type ReaderChatIssue = (
  | { kind: "Model" | "Catalog"; message: string; destination: "New" | "Existing"; selection: Selection | null }
  | { kind: "Changed" | "Missing" | "Passage" | "Source" | "Failed"; message: string }
) & { /** The submitted chat command was definitively refused after its highlight was saved. */ highlightSaved?: true };

type ChatAttempt =
  | { kind: "Preparing"; runId: string }
  | { kind: "Dispatched"; runId: string; owner: ConversationCommands; selection: Selection; destination: "New" | "Existing"; input: { revision: number; consumedRevision: number | null } };

export interface ComposerDraft {
  id: string;
  /** visual anchor only; capture-only fields belong to reference/publication inputs. */
  passage: Passage & { quote: string };
  referenceSource: Schema<"LinkFragmentSelectionSource"> | Schema<"LinkPdfSelectionSource">;
  highlightId: string | null;
  highlight: Schema<"TypedHighlightOut"> | null;
  noteId: string;
  linkId: string;
  linksVersion: number | null;
  publication: Extract<Publication, { kind: "passage" | "attach_highlight" }> | null;
  write: WriteHandle | null;
  base: NoteBase;
  body: NoteBody;
  revision: number;
  selection: NoteEdit["selectionAfter"] | null;
  history: NoteBodyHistory;
  load: "Loading" | "Ready" | "Failed";
  operation: { id: string; kind: "Save" | "Chat" | "Ensure" | "Highlight" | "Delete" } | null;
  issue: DraftIssue | null;
  referenceActive: boolean;
  attachmentActive: boolean;
  sourceMediaId: string;
  sourceHasChats: boolean | null;
  destination: ChatDestination;
  chatAttempt: ChatAttempt | null;
  chatIssue: ReaderChatIssue | null;
}

/** One ephemeral working value. Submitted requests belong to their live owners. */
export function createSelectionDrafts() {
  let drafts: readonly ComposerDraft[] = [];
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => drafts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    put(draft: ComposerDraft) {
      drafts = [draft];
      for (const listener of listeners) listener();
    },
    remove(id: string) {
      drafts = drafts.filter(draft => draft.id !== id);
      for (const listener of listeners) listener();
    },
    update(id: string, change: (draft: ComposerDraft) => ComposerDraft) {
      const current = drafts.find(draft => draft.id === id);
      if (!current) return;
      const next = change(current);
      if (next === current) return;
      drafts = drafts.map(draft => draft.id === id ? next : draft);
      for (const listener of listeners) listener();
    },
  };
}

export type SelectionDrafts = ReturnType<typeof createSelectionDrafts>;

export function samePassage(a: Passage, b: Passage): boolean {
  return a.identity === b.identity && sameAnchor(a.anchor, b.anchor);
}

/** Text projection cannot distinguish empty text from images, breaks or code. */
export function isEmptyParagraph(body: NoteBody): boolean {
  return body.body_pm_json.type === "paragraph" &&
    (!Array.isArray(body.body_pm_json.content) || body.body_pm_json.content.length === 0);
}

export function noteBase(highlight: Schema<"TypedHighlightOut">): NoteBase {
  if (highlight.linked_note_blocks.length > 1)
    throw new Error("A highlight has more than one note for this viewer");
  const note = highlight.linked_note_blocks[0];
  return note
    ? { kind: "Present", id: note.note_block_id, linkId: note.link_id, version: note.body_version,
      body: parseBody(note.body_pm_json), embeddedItem: note.embedded_item ?? null }
    : { kind: "Absent" };
}

export function initialBody(base: NoteBase): NoteBody {
  return base.kind === "Present" ? base.body : emptyBody();
}
