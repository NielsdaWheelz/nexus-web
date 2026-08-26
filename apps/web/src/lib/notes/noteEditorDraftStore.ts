import { createRandomId } from "@/lib/createRandomId";
import { decodeNoteBodyValue, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";
import {
  expectExactRecord,
  expectInteger,
  expectIsoInstant,
  expectNonemptyString,
  isCanonicalUuid,
} from "@/lib/validation";

const NOTE_DRAFT_STORAGE_PREFIX = "nexus.noteBodyDraft:";
const STORED_NOTE_EDITOR_DRAFT_KEYS = [
  "version",
  "bodyPmJson",
  "bodyText",
  "metadata",
  "sequence",
  "clientMutationId",
  "updatedAt",
] as const;

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

function expectStoredDraftSequence(raw: unknown): number {
  const sequence = expectInteger(raw, "note editor draft.sequence");
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new TypeError("note editor draft.sequence must be a positive safe integer");
  }
  return sequence;
}

function expectClientMutationId(raw: unknown, sequence: number): string {
  const value = expectNonemptyString(raw, "note editor draft.clientMutationId");
  const prefix = `note-${sequence}-`;
  if (!value.startsWith(prefix) || !isCanonicalUuid(value.slice(prefix.length))) {
    throw new TypeError(
      "note editor draft.clientMutationId must match its sequence and canonical UUID",
    );
  }
  return value;
}

export function createNoteEditorClientMutationId(sequence: number): string {
  return `note-${sequence}-${createRandomId()}`;
}

export function decodeStoredNoteEditorDraft(raw: unknown): StoredNoteEditorDraft {
  const draft = expectExactRecord(
    raw,
    STORED_NOTE_EDITOR_DRAFT_KEYS,
    "note editor draft",
  );
  if (draft.version !== 1) {
    throw new TypeError("note editor draft.version must be 1");
  }
  const sequence = expectStoredDraftSequence(draft.sequence);
  return {
    version: 1,
    body: decodeNoteBodyValue(
      draft.bodyPmJson,
      draft.bodyText,
      "note editor draft",
    ),
    metadata: draft.metadata,
    sequence,
    clientMutationId: expectClientMutationId(draft.clientMutationId, sequence),
    updatedAt: expectIsoInstant(draft.updatedAt, "note editor draft.updatedAt"),
  };
}

export function readStoredNoteEditorDraft(
  resourceKey: string,
): StoredNoteEditorDraft | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(noteEditorDraftStorageKey(resourceKey));
  if (raw === null) return null;
  return decodeStoredNoteEditorDraft(JSON.parse(raw) as unknown);
}

export function storeNoteEditorDraft(
  resourceKey: string,
  body: NoteBodyValue,
  metadata: unknown,
  sequence: number,
  clientMutationId: string,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      noteEditorDraftStorageKey(resourceKey),
      JSON.stringify({
        version: 1,
        bodyPmJson: body.bodyPmJson,
        bodyText: body.bodyText,
        metadata,
        sequence,
        clientMutationId,
        updatedAt: new Date().toISOString(),
      }),
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
