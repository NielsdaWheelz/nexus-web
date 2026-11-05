import type { ExcerptBody } from "@nexus/authored/excerpt";
import type { NoteEditorProps } from "@/components/notes/NoteEditor";
import type { Passage } from "@/lib/documentReader/DocumentReader";
import { sameAnchor } from "@/lib/documentReader/anchors";
import type { ConversationTree } from "@/lib/chat/commands";
import type { HighlightColor } from "@/lib/documentReader/model";
import type { SelectionEditor } from "@/lib/chat/selection";
import { sameBody } from "@nexus/authored/body";
import type { Capture } from "@/lib/documentReader/annotations";
import type { Line } from "@/components/feedback/stage";
import type { ApiError } from "@/lib/api/client";

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
  | { kind: "Source" | "Capture" | "Capacity"; line: Line }
  /** Preparation retries its retained gesture and says so in the composer. Commit retries its
   * frozen account command; its one home is the writing runtime's risk slip. */
  | { kind: "Failed"; phase: "Preparation"; attempt: number; retry: () => void }
  | { kind: "Failed"; phase: "Commit"; retry: () => void };

export type ChatDestination =
  | { kind: "Resolving" | "Absent" }
  | { kind: "LookupFailed"; error: ApiError }
  | { kind: "Selected"; id: string; title: string; read: number; snapshot:
      | { kind: "Loading" | "Failed" | "RefreshRequired" }
      | { kind: "Ready"; tree: ConversationTree } };

export type ReaderChatIssue = { kind: "Missing" | "Passage" | "Source" | "Failed"; line: Line };

export interface ComposerDraft {
  id: string;
  /** Visual anchor and literal quote; capture-only fields live in `capture`. */
  passage: Passage & { quote: string; excerpt: ExcerptBody | null; excerpt_start: number | null; excerpt_end: number | null };
  /** A new selection's frozen local capture; null when the draft opened an existing highlight. */
  capture: Capture | null;
  /** The highlight whose permanent annotation is independent from this question draft. */
  highlightId: string | null;
  color: HighlightColor;
  bodyRole: "annotation_or_question" | "question";
  annotationBase: string | null;
  /** Unsubmitted annotation-or-question input. Intentional loss uses the work guard. */
  body: Body;
  revision: number;
  selection: NoteEdit["selectionAfter"] | null;
  history: DraftHistory;
  operation: { id: string; kind: "Save" | "Ensure" | "Highlight" } | null;
  issue: DraftIssue | null;
  referenceActive: boolean;
  linkInputActive: boolean;
  attachmentActive: boolean;
  sourceMediaId: string;
  destination: ChatDestination;
  chatSelection: SelectionEditor;
  chatIssue: ReaderChatIssue | null;
}

export function samePassage(a: Passage, b: Passage): boolean {
  return a.identity === b.identity && sameAnchor(a.anchor, b.anchor);
}
