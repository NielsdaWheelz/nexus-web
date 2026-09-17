import { createRandomId } from "@/lib/createRandomId";
import { decodeNoteBodyValue, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";

const NOTE_DRAFT_STORAGE_PREFIX = "nexus.noteBodyDraft:";

export interface StoredNoteEditorDraft {
  version: 1;
  body: NoteBodyValue;
  metadata: unknown;
  sequence: number;
  clientMutationId: string;
  updatedAt: string;
}

export function noteEditorDraftStorageKey(resourceKey: string): string {
  return `${NOTE_DRAFT_STORAGE_PREFIX}${resourceKey}`;
}

export function createNoteEditorClientMutationId(sequence: number): string {
  return `note-${sequence}-${createRandomId()}`;
}

export function readStoredNoteEditorDraft(
  resourceKey: string,
): StoredNoteEditorDraft | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(noteEditorDraftStorageKey(resourceKey));
  if (raw === null) return null;
  try {
    const stored = JSON.parse(raw) as StoredNoteEditorDraft & {
      bodyPmJson: unknown;
      bodyText: unknown;
    };
    if (stored.version !== 1) {
      throw new TypeError("note editor draft.version must be 1");
    }
    return {
      version: 1,
      // The body mounts in a ProseMirror editor, which cannot render invalid
      // document JSON.
      body: decodeNoteBodyValue(
        stored.bodyPmJson,
        stored.bodyText,
        "note editor draft",
      ),
      metadata: stored.metadata,
      sequence: stored.sequence,
      clientMutationId: stored.clientMutationId,
      updatedAt: stored.updatedAt,
    };
  } catch {
    clearStoredNoteEditorDraft(resourceKey);
    return null;
  }
}

export function storeNoteEditorDraft(
  resourceKey: string,
  body: NoteBodyValue,
  metadata: unknown,
  sequence: number,
  clientMutationId: string,
): void {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify({
    version: 1,
    bodyPmJson: body.bodyPmJson,
    bodyText: body.bodyText,
    metadata,
    sequence,
    clientMutationId,
    updatedAt: new Date().toISOString(),
  });
  try {
    window.localStorage.setItem(
      noteEditorDraftStorageKey(resourceKey),
      serialized,
    );
  } catch {
    // Local recovery may be unavailable; the owning network autosave continues.
  }
}

export function clearStoredNoteEditorDraft(resourceKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(noteEditorDraftStorageKey(resourceKey));
  } catch {
    // Local recovery may be unavailable; there is no durable row to clear.
  }
}
