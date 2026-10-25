import type { NoteEditorProps } from "@/components/notes/NoteEditor";
import type { Passage } from "@/lib/documentReader/DocumentReader";
import { sameAnchor } from "@/lib/documentReader/anchors";
import type { ConversationCommands, ConversationTree } from "@/lib/chat/commands";
import type { Selection } from "@/lib/chat/wire";
import { sameBody } from "@nexus/authored/body";
import type { Capture } from "@/lib/documentReader/annotations";

export type NoteEdit = Parameters<NoteEditorProps["onEdit"]>[0];
type Body = NoteEditorProps["body"];

/** The composer's own undo over its unsubmitted input; saved notes use their documents' undo. */
export interface DraftHistory {
  undo: Array<NoteEdit & { group: number }>;
  redo: Array<NoteEdit & { group: number }>;
  group: number;
}
export const emptyDraftHistory = (): DraftHistory => ({ undo: [], redo: [], group: 0 });

/** Contiguous typing shares a group; selection, composition and commands break it. */
export function recordDraftEdit(history: DraftHistory, edit: NoteEdit): DraftHistory {
  const last = history.undo.at(-1);
  if (edit.source === "input" && last?.source === "input" && last.group === history.group && sameBody(last.after, edit.before))
    return { ...history, redo: [], undo: [...history.undo.slice(0, -1), { ...last, after: edit.after, selectionAfter: edit.selectionAfter }] };
  return { undo: [...history.undo, { ...edit, group: history.group }], redo: [], group: history.group + (edit.source === "input" ? 0 : 1) };
}

export type DraftIssue =
  | { kind: "Source"; message: string }
  /** A local commit that did not persist: its frozen command retries; the input stays. */
  | { kind: "Failed"; message: string; retry: () => void };

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
  /** Visual anchor and literal quote; capture-only fields live in `capture`. */
  passage: Passage & { quote: string };
  /** A new selection's frozen local capture; null when the draft opened an existing highlight. */
  capture: Capture | null;
  /** The annotated highlight, once it exists. Its notes are its own resources, never this draft. */
  highlightId: string | null;
  /** The unsubmitted new note. Saving commits it locally; dismissal discards it. */
  body: Body;
  revision: number;
  selection: NoteEdit["selectionAfter"] | null;
  history: DraftHistory;
  operation: { id: string; kind: "Save" | "Chat" | "Ensure" | "Highlight" } | null;
  issue: DraftIssue | null;
  referenceActive: boolean;
  attachmentActive: boolean;
  sourceMediaId: string;
  sourceHasChats: boolean | null;
  destination: ChatDestination;
  chatAttempt: ChatAttempt | null;
  chatIssue: ReaderChatIssue | null;
}

/** One ephemeral working value. Submitted commands belong to the local writing runtime. */
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
