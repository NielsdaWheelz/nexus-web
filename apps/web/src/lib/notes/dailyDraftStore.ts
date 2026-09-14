import { isLocalDate } from "@/lib/localDate";
import {
  expectExactRecord,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function dailyDraftKey(accountId: string, localDate: string): string {
  if (accountId.length === 0 || !isLocalDate(localDate)) {
    throw new TypeError("daily draft identity is invalid");
  }
  return `nexus.dailyDraft:${accountId}:${localDate}`;
}

function decodeDailyDraft(raw: unknown): DailyDraft {
  const draft = expectExactRecord(
    raw,
    [
      "version",
      "accountId",
      "localDate",
      "noteId",
      "clientMutationId",
      "bodyPmJson",
      "bodyText",
      "handoff",
    ],
    "daily draft",
  );
  if (draft.version !== 1) {
    throw new TypeError("daily draft.version must be 1");
  }
  const localDate = expectString(draft.localDate, "daily draft.localDate");
  if (!isLocalDate(localDate)) {
    throw new TypeError("daily draft.localDate must be a valid YYYY-MM-DD date");
  }
  const handoff = expectRecord(draft.handoff, "daily draft.handoff");
  const handoffKind = expectOneOf(
    handoff.kind,
    ["None", "Buffered"] as const,
    "daily draft.handoff.kind",
  );
  let decodedHandoff: DailyDraftHandoff;
  if (handoffKind === "None") {
    expectExactRecord(handoff, ["kind"], "daily draft.handoff");
    decodedHandoff = { kind: "None" };
  } else {
    const buffered = expectExactRecord(
      handoff,
      [
        "kind",
        "handoffId",
        "text",
        "selectionStart",
        "selectionEnd",
        "composition",
      ],
      "daily draft.handoff",
    );
    if (
      typeof buffered.selectionStart !== "number" ||
      !Number.isInteger(buffered.selectionStart) ||
      buffered.selectionStart < 0 ||
      typeof buffered.selectionEnd !== "number" ||
      !Number.isInteger(buffered.selectionEnd) ||
      buffered.selectionEnd < buffered.selectionStart
    ) {
      throw new TypeError("daily draft handoff selection is invalid");
    }
    decodedHandoff = {
      kind: "Buffered",
      handoffId: expectString(
        buffered.handoffId,
        "daily draft.handoff.handoffId",
      ),
      text: expectString(buffered.text, "daily draft.handoff.text"),
      selectionStart: buffered.selectionStart,
      selectionEnd: buffered.selectionEnd,
      composition: expectOneOf(
        buffered.composition,
        ["Composing", "Complete"] as const,
        "daily draft.handoff.composition",
      ),
    };
  }
  const noteId = expectString(draft.noteId, "daily draft.noteId");
  if (!UUID_RE.test(noteId)) {
    throw new TypeError("daily draft.noteId must be a canonical UUID");
  }
  const clientMutationId = expectString(
    draft.clientMutationId,
    "daily draft.clientMutationId",
  );
  if (clientMutationId.length === 0 || clientMutationId.length > 120) {
    throw new TypeError(
      "daily draft.clientMutationId must contain 1 to 120 characters",
    );
  }
  return {
    version: 1,
    accountId: expectString(draft.accountId, "daily draft.accountId"),
    localDate,
    noteId,
    clientMutationId,
    bodyPmJson: expectRecord(draft.bodyPmJson, "daily draft.bodyPmJson"),
    bodyText: expectString(draft.bodyText, "daily draft.bodyText"),
    handoff: decodedHandoff,
  };
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
    const draft = decodeDailyDraft(JSON.parse(value));
    if (draft.accountId !== accountId || draft.localDate !== localDate) {
      throw new TypeError("daily draft identity does not match its storage key");
    }
    return draft;
  } catch {
    storage()?.removeItem(key);
    return null;
  }
}

export function writeDailyDraft(draft: DailyDraft): void {
  storage()?.setItem(
    dailyDraftKey(draft.accountId, draft.localDate),
    JSON.stringify(decodeDailyDraft(draft)),
  );
  publishDailyDraftChange(draft.accountId, draft.localDate);
}

export function clearDailyDraft(accountId: string, localDate: string): void {
  storage()?.removeItem(dailyDraftKey(accountId, localDate));
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
