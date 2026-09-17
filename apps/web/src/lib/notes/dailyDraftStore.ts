import { isLocalDate } from "@/lib/localDate";
import { decodeNoteBodyValue } from "@/lib/notes/prosemirror/schema";

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

export interface DailyDraft {
  version: 1;
  accountId: string;
  localDate: string;
  noteId: string;
  clientMutationId: string;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  handoff: DailyDraftHandoff;
}

export function dailyDraftKey(accountId: string, localDate: string): string {
  if (accountId.length === 0 || !isLocalDate(localDate)) {
    throw new TypeError("daily draft identity is invalid");
  }
  return `nexus.dailyDraft:${accountId}:${localDate}`;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function readDailyDraft(
  accountId: string,
  localDate: string,
): DailyDraft | null {
  const key = dailyDraftKey(accountId, localDate);
  const value = storage()?.getItem(key);
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const draft = JSON.parse(value) as DailyDraft;
    if (
      draft.version !== 1 ||
      draft.accountId !== accountId ||
      draft.localDate !== localDate
    ) {
      throw new TypeError("daily draft identity does not match its storage key");
    }
    // The body mounts in a ProseMirror editor, which cannot render invalid
    // document JSON.
    decodeNoteBodyValue(draft.bodyPmJson, draft.bodyText, "daily draft");
    return draft;
  } catch {
    storage()?.removeItem(key);
    return null;
  }
}

export function writeDailyDraft(draft: DailyDraft): void {
  try {
    storage()?.setItem(
      dailyDraftKey(draft.accountId, draft.localDate),
      JSON.stringify(draft),
    );
  } catch {
    // Local recovery may be unavailable; the owning network save continues.
  }
  publishDailyDraftChange(draft.accountId, draft.localDate);
}

export function clearDailyDraft(accountId: string, localDate: string): void {
  try {
    storage()?.removeItem(dailyDraftKey(accountId, localDate));
  } catch {
    // Local recovery may be unavailable; there is no durable row to clear.
  }
  publishDailyDraftChange(accountId, localDate);
}

export const DAILY_DRAFT_CHANGE_EVENT = "nexus:daily-draft-change";
export const DAILY_DRAFT_HANDOFF_CLAIM_EVENT =
  "nexus:daily-draft-handoff-claim";

function publishDailyDraftChange(accountId: string, localDate: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(DAILY_DRAFT_CHANGE_EVENT, {
      detail: { accountId, localDate },
    }),
  );
}

export function acknowledgeDailyDraftHandoff(
  accountId: string,
  localDate: string,
  handoffId: string,
): boolean {
  const draft = readDailyDraft(accountId, localDate);
  if (
    !draft ||
    draft.handoff.kind !== "Buffered" ||
    draft.handoff.handoffId !== handoffId
  ) {
    return false;
  }
  writeDailyDraft({ ...draft, handoff: { kind: "None" } });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(DAILY_DRAFT_HANDOFF_CLAIM_EVENT, {
        detail: { accountId, localDate, handoffId },
      }),
    );
  }
  return true;
}

export function subscribeDailyDraft(
  accountId: string,
  localDate: string,
  listener: (draft: DailyDraft | null) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const onChange = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      typeof detail !== "object" ||
      detail === null ||
      !("accountId" in detail) ||
      !("localDate" in detail) ||
      detail.accountId !== accountId ||
      detail.localDate !== localDate
    ) {
      return;
    }
    listener(readDailyDraft(accountId, localDate));
  };
  window.addEventListener(DAILY_DRAFT_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(DAILY_DRAFT_CHANGE_EVENT, onChange);
}
