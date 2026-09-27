import { isLocalDate } from "@/lib/localDate";
import { decodeNoteBodyValue, type NoteBodyValue } from "@/lib/notes/prosemirror/schema";

export type DailyDraftHandoff =
  | { kind: "None" }
  | {
      kind: "Buffered";
      handoffId: string;
      text: string;
      selectionStart: number;
      selectionEnd: number;
      composition: "Composing" | "Complete";
    };

/** Only the pre-mount seed and gesture-time buffer live here. Mounted prose lives in the writing journal. */
export interface DailyDraft {
  version: 2;
  accountId: string;
  localDate: string;
  noteId: string;
  clientMutationId: string;
  seedBody: NoteBodyValue | null;
  handoff: DailyDraftHandoff;
}

export function dailyDraftKey(accountId: string, localDate: string): string {
  if (accountId.length === 0 || !isLocalDate(localDate)) {
    throw new TypeError("daily draft identity is invalid");
  }
  return `nexus.dailyHandoff:v2:${accountId}:${localDate}`;
}

export class DailyDraftStorageError extends Error {
  constructor() { super("Daily draft storage is unavailable on this device"); this.name = "DailyDraftStorageError"; }
}

export function readDailyDraftRaw(accountId: string, localDate: string): string | null {
  if (typeof window === "undefined") return null;
  const key = dailyDraftKey(accountId, localDate);
  try { return window.localStorage.getItem(key); }
  catch { throw new DailyDraftStorageError(); }
}

export function readDailyDraft(accountId: string, localDate: string): DailyDraft | null {
  const raw = readDailyDraftRaw(accountId, localDate);
  if (raw === null) return null;
  try {
    const draft = JSON.parse(raw) as DailyDraft;
    if (
      draft.version !== 2 || draft.accountId !== accountId || draft.localDate !== localDate ||
      typeof draft.noteId !== "string" || typeof draft.clientMutationId !== "string" ||
      !draft.handoff || (draft.handoff.kind !== "None" && draft.handoff.kind !== "Buffered")
    ) throw new TypeError("daily draft identity or shape is invalid");
    if (draft.seedBody !== null) {
      draft.seedBody = decodeNoteBodyValue(draft.seedBody.bodyPmJson, draft.seedBody.bodyText, "daily draft seed");
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeDailyDraft(draft: DailyDraft): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (readDailyDraftRaw(draft.accountId, draft.localDate) !== null && readDailyDraft(draft.accountId, draft.localDate) === null) return false;
    window.localStorage.setItem(dailyDraftKey(draft.accountId, draft.localDate), JSON.stringify(draft));
  } catch {
    return false;
  }
  publishDailyDraftChange(draft.accountId, draft.localDate);
  return true;
}

export function clearDailyDraft(accountId: string, localDate: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (readDailyDraftRaw(accountId, localDate) !== null && readDailyDraft(accountId, localDate) === null) return false;
    window.localStorage.removeItem(dailyDraftKey(accountId, localDate));
  } catch {
    return false;
  }
  publishDailyDraftChange(accountId, localDate);
  return true;
}

export function discardDailyDraftRaw(accountId: string, localDate: string): boolean {
  if (typeof window === "undefined") return false;
  try { window.localStorage.removeItem(dailyDraftKey(accountId, localDate)); }
  catch { return false; }
  publishDailyDraftChange(accountId, localDate);
  return true;
}

export function claimDailyDraftBody(accountId: string, localDate: string, noteId: string): boolean {
  let draft: DailyDraft | null;
  try { draft = readDailyDraft(accountId, localDate); }
  catch (error) {
    if (error instanceof DailyDraftStorageError) return false;
    throw error;
  }
  if (!draft || draft.noteId !== noteId) return false;
  if (draft.seedBody === null) return true;
  return writeDailyDraft({ ...draft, seedBody: null });
}

export const DAILY_DRAFT_CHANGE_EVENT = "nexus:daily-draft-change";
export const DAILY_DRAFT_HANDOFF_CLAIM_EVENT = "nexus:daily-draft-handoff-claim";

function publishDailyDraftChange(accountId: string, localDate: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DAILY_DRAFT_CHANGE_EVENT, { detail: { accountId, localDate } }));
}

export function acknowledgeDailyDraftHandoff(accountId: string, localDate: string, handoffId: string): boolean {
  let draft: DailyDraft | null;
  try { draft = readDailyDraft(accountId, localDate); }
  catch (error) {
    if (error instanceof DailyDraftStorageError) return false;
    throw error;
  }
  if (!draft || draft.handoff.kind !== "Buffered" || draft.handoff.handoffId !== handoffId) return false;
  if (!writeDailyDraft({ ...draft, handoff: { kind: "None" } })) return false;
  window.dispatchEvent(new CustomEvent(DAILY_DRAFT_HANDOFF_CLAIM_EVENT, { detail: { accountId, localDate, handoffId } }));
  return true;
}

export function subscribeDailyDraft(accountId: string, localDate: string, listener: (draft: DailyDraft | null, storageUnavailable: boolean) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onChange = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      typeof detail !== "object" || detail === null || !("accountId" in detail) || !("localDate" in detail) ||
      detail.accountId !== accountId || detail.localDate !== localDate
    ) return;
    let draft: DailyDraft | null;
    try { draft = readDailyDraft(accountId, localDate); }
    catch (error) {
      if (!(error instanceof DailyDraftStorageError)) throw error;
      listener(null, true);
      return;
    }
    listener(draft, false);
  };
  window.addEventListener(DAILY_DRAFT_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(DAILY_DRAFT_CHANGE_EVENT, onChange);
}
