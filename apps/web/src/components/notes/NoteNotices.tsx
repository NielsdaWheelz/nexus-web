"use client";

// Writing status beside its text, and the explicit decisions a retained draft needs.
// Status is quiet and scoped: typing announces nothing. Writing is called saved on
// this device only after its local checkpoint completed. Rich values stay rich in
// every comparison; a decision is a new intent against the version shown.
import { DOMSerializer } from "prosemirror-model";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus, useFeedback, type FeedbackActions, type FeedbackContextValue } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { noteBodySchema, parseBody } from "@/lib/notes/noteBody";
import {
  admitWriting,
  discardDraft,
  draftIsDurable,
  exportWriting,
  openDraft,
  readWriting,
  releaseDraft,
  retryWriting,
  sameDraftValue,
  stageDraft,
  subscribeWriting,
  WritingDecisionError,
  writingRuntimeToken,
  type ConflictShown,
  type DraftSnapshot,
  type DraftValue,
  type WritingRuntimeToken,
  type WritingSnapshot,
} from "@/lib/notes/journal";
import { resolveConflict, setGone, textDraft, useText, type TextWritingState } from "@/lib/notes/texts";
import { offlineAvailable, saveWritingExport } from "@/lib/offline/bridge";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import styles from "./NoteNotices.module.css";

export function useWriting(): WritingSnapshot {
  return useSyncExternalStore(subscribeWriting, readWriting, readWriting);
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

export function writingFileName(): string {
  return `nexus-writing-${new Date().toISOString().slice(0, 10)}.json`;
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/**
 * The one recovery file of the runtime `token` names. "saved": the browser or
 * Android's shell finished writing it. "started": a plain download began, which
 * only the person can confirm arrived. "cancelled": nothing was saved. The picker
 * opens first, inside the click's activation.
 */
export async function saveWritingFile(token: WritingRuntimeToken): Promise<"saved" | "started" | "cancelled"> {
  // Android's webview saves no browser downloads; its shell writes the file and
  // answers only after flushing and closing it.
  if (offlineAvailable) {
    const blob = await exportWriting(token);
    try {
      await saveWritingExport(blob, token.account_id);
    } catch (error) {
      if (error instanceof Error && error.message === "Cancelled") return "cancelled";
      throw error;
    }
    return "saved";
  }
  // justify-type-assertion: lib.dom does not declare the file system access picker.
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let file: FileSystemFileHandle;
    try {
      file = await picker({
        suggestedName: writingFileName(),
        types: [{ description: "nexus writing", accept: { "application/json": [".json"] } }],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      throw error;
    }
    const blob = await exportWriting(token);
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  }
  const url = URL.createObjectURL(await exportWriting(token));
  const link = document.createElement("a");
  link.href = url;
  link.download = writingFileName();
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "started";
}

/** A download offered beside other choices: a failed save says so and removes nothing. */
export function downloadWriting(feedback: FeedbackContextValue, accountId: string): void {
  const token = writingRuntimeToken();
  // justify-defect: callers name the reviewed account whose journal runs in this tab.
  if (token.account_id !== accountId) throw new Error("writing runtime belongs to another account");
  saveWritingFile(token).catch((error: unknown) => {
    reportError(error);
    feedback.offer({ key: "writing-download", announcement: "Polite", content: { tone: "Warning", title: "the file couldn’t be saved.", message: "nothing was removed." } });
  });
}

/** Plain text to the clipboard; where that is refused, the person selects it. */
export function copyWriting(feedback: FeedbackContextValue, text: string): void {
  void copyText(text).catch((error: unknown) => {
    if (!(error instanceof ClipboardWriteUnavailableError)) throw error;
    feedback.offer({ key: "writing-copy", announcement: "Polite", content: { tone: "Warning", title: "copy unavailable", message: "select the text and copy it before leaving." } });
  });
}

export function draftText(value: DraftValue): string {
  switch (value.kind) {
    case "body": return parseBody(value.body_pm_json).body_text;
    case "title":
    case "capture": return value.text;
    case "reference": return value.raw;
  }
}

/** What the person would call this writing. */
export function draftSubject(draft: DraftSnapshot): string {
  switch (draft.context.kind) {
    case "body": return draft.context.publication?.kind === "page" ? "new page" : "note";
    case "composer": return "note";
    case "title": return "page title";
    case "capture": return "daily capture";
    case "passage": return "passage note";
    case "reference": return "reference";
  }
}

/** A changed or unsent branch: work that a clean read cannot restore. */
export function draftIsDirty(draft: DraftSnapshot): boolean {
  return draft.base === null ? draft.revision > 0 : !sameDraftValue(draft.value, draft.base.value);
}

/** The decision a refused change leaves, by its refusal code. */
export function refusalTitle(code: string, subject: string): string {
  switch (code) {
    case "E_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
    case "E_WRITING_DEPENDENCY_GONE":
      return `this ${subject} was deleted.`;
    case "E_READER_CONTENT_CHANGED":
    case "E_CONTEXT_CHANGED":
    case "E_HIGHLIGHT_INVALID_RANGE":
    case "E_MEDIA_DELETING":
      return "the source changed.";
    case "E_RESOURCE_CONFLICT":
    case "E_LINK_TARGET_STALE":
    case "E_LINK_TARGET_AMBIGUOUS":
    case "E_LINK_CAPABILITY":
      return "the outline changed.";
    case "retired":
      return "delivery stopped. an earlier attempt may still finish.";
    case "predecessor_discarded":
      return "an earlier change was discarded.";
    default:
      return `this ${subject} wasn’t saved.`;
  }
}

function refusalMessage(code: string, kept: boolean): string {
  if (!kept) return "your words are only in this tab. copy or download them.";
  switch (code) {
    case "E_READER_CONTENT_CHANGED":
    case "E_CONTEXT_CHANGED":
    case "E_HIGHLIGHT_INVALID_RANGE":
    case "E_MEDIA_DELETING":
      return "your words are kept; select the passage again.";
    case "E_RESOURCE_CONFLICT":
    case "E_LINK_TARGET_STALE":
    case "E_LINK_TARGET_AMBIGUOUS":
    case "E_LINK_CAPABILITY":
      return "your draft is kept. review where it should go.";
    default:
      return "your draft is kept.";
  }
}

/** One rich value, rendered read-only through the note schema. */
function RichValue({ value }: { value: DraftValue }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (value.kind !== "body") return;
    const block = noteBodySchema.nodeFromJSON(value.body_pm_json);
    host.current!.replaceChildren(DOMSerializer.fromSchema(noteBodySchema).serializeNode(block));
  }, [value]);
  if (value.kind !== "body") return <p className={styles.plain}>{draftText(value) || "(empty)"}</p>;
  return <div ref={host} className={styles.rich} />;
}

function Comparison({ entries }: { entries: readonly { label: string; value: DraftValue }[] }) {
  const [first, ...rest] = entries;
  const formattingOnly = first !== undefined && rest.length > 0 && rest.every(entry =>
    !sameDraftValue(entry.value, first.value) && draftText(entry.value) === draftText(first.value));
  return <>
    <dl className={styles.compare}>
      {entries.map(entry => <div key={entry.label} className={styles.compareRow}>
        <dt>{entry.label}</dt>
        <dd><RichValue value={entry.value} /></dd>
      </div>)}
    </dl>
    {formattingOnly ? <p className={styles.formatting}>only the formatting differs.</p> : null}
  </>;
}

/** A body draft becomes a fresh page. Its caller resolves the old branch only after
 * this acknowledgement; historical ids never change. */
async function saveAsNewNote(value: Extract<DraftValue, { kind: "body" }>): Promise<void> {
  const request = {
    id: crypto.randomUUID(),
    title: "recovered note",
    initial_item: { kind: "note" as const, note_id: crypto.randomUUID(), link_id: crypto.randomUUID(), body_pm_json: value.body_pm_json },
  };
  const intent = { kind: "page" as const, request };
  // The runtime that showed this draft must be the one that admits its copy.
  const token = writingRuntimeToken();
  const fresh = await openDraft({ kind: "body", resource_ref: `note_block:${request.initial_item.note_id}`, publication: intent }, value, null);
  const now = writingRuntimeToken();
  if (now.account_id !== token.account_id || now.generation !== token.generation) {
    await releaseDraft(fresh);
    throw new WritingDecisionError("writing restarted; review this draft again.");
  }
  try {
    await admitWriting(intent, [stageDraft(fresh, value, null)]).settled;
  } finally {
    await releaseDraft(fresh);
  }
}

/** The explicit choices for one retained branch this tab owns. */
export function DraftDecision({ draft, outlived = false, resolve, retire }: {
  draft: DraftSnapshot;
  /** The resource is gone: only a new identity or a copy can keep these words. */
  outlived?: boolean;
  /** A new intent against the revision and saved version shown; anything newer is refused. */
  resolve: (decision: "mine" | "saved", shown: ConflictShown) => Promise<void>;
  /** Settles the old branch once its words were saved as a new note; null withholds that choice. */
  retire: ((shown: ConflictShown) => Promise<void>) | null;
}) {
  const feedback = useFeedback();
  const account = useOptionalAuthenticatedAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const subject = draftSubject(draft);
  const kept = draftIsDurable(draft.draft_id);
  const conflict = draft.conflict;
  const shown: ConflictShown = { revision: draft.revision, saved_version: conflict?.saved_version ?? null };
  const decide = (label: string, work: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(label);
    work().then(
      () => setBusy(null),
      (error: unknown) => {
        setBusy(null);
        if (!(error instanceof WritingDecisionError)) reportError(error);
        feedback.offer({
          key: `draft-decision:${draft.draft_id}`,
          announcement: "Polite",
          content: { tone: "Warning", title: "couldn’t apply this choice.", message: error instanceof WritingDecisionError ? error.message : "your draft is unchanged." },
        });
      },
    );
  };
  const button = (label: string, onClick: () => void, variant: "secondary" | "ghost" | "danger" = "ghost") =>
    <Button size="sm" variant={variant} aria-busy={busy === label || undefined} aria-disabled={busy !== null || undefined} onClick={onClick}>{label}</Button>;
  const value = draft.value;
  const asNew = value.kind === "body" && retire !== null
    ? button("save as a new note", () => decide("save as a new note", async () => {
      await saveAsNewNote(value);
      await retire(shown);
      feedback.receipt({ tone: "Success", title: "saved as a new note." });
    }))
    : null;
  // Outside the authenticated shell no reviewed account names the file.
  const download = account === null ? null : button("download writing", () => downloadWriting(feedback, account.accountId));

  if (!outlived && conflict !== null && conflict.saved_value !== null) {
    const other = conflict.other_draft_id !== null;
    return <div className={styles.conflict}>
      <FeedbackNotice
        content={{ tone: "Warning", title: other ? `another draft of this ${subject} is open.` : `this ${subject} changed elsewhere.`, message: kept ? "your draft is kept. choose which version to keep." : "your words are only in this tab." }}
        announcement="Polite"
      />
      <Comparison entries={[
        ...(draft.base === null ? [] : [{ label: "before", value: draft.base.value }]),
        { label: "your draft", value: draft.value },
        { label: other ? "other draft" : "saved", value: conflict.saved_value },
      ]} />
      <div className={styles.actions}>
        {button(other ? "keep this draft" : "replace the saved version", () => decide("mine", () => resolve("mine", shown)), "secondary")}
        {button(other ? "use other draft" : "use saved version", () => decide("saved", () => resolve("saved", shown)))}
        {asNew}
        {download}
      </div>
    </div>;
  }
  const code = outlived ? "E_NOT_FOUND" : conflict?.reason ?? "E_UNKNOWN";
  return <div className={styles.conflict}>
    <FeedbackNotice content={{ tone: "Warning", title: refusalTitle(code, subject), message: refusalMessage(code, kept) }} announcement="Polite" />
    <Comparison entries={[{ label: "your draft", value: draft.value }]} />
    <div className={styles.actions}>
      {asNew}
      {button("copy text", () => copyWriting(feedback, draftText(draft.value)))}
      {download}
    </div>
  </div>;
}

const TEXT_STATUS: Record<Exclude<TextWritingState, "blocked">, { tone: "Neutral" | "Warning"; title: string; message?: string }> = {
  saving: { tone: "Neutral", title: "saving…" },
  local_syncing: { tone: "Neutral", title: "saved on this device · syncing" },
  local_offline: { tone: "Neutral", title: "saved on this device · offline" },
  synced: { tone: "Neutral", title: "synced" },
  draft: { tone: "Neutral", title: "draft saved on this device" },
  memory_only: { tone: "Warning", title: "recent changes are only in this tab.", message: "keep it open or download your writing." },
  uncertain: { tone: "Warning", title: "couldn’t confirm this change.", message: "your draft is kept." },
};

/**
 * Quiet delivery status. With a text ref: that text's latest revision in this tab;
 * a refusal or conflict is NoteConflict's. Without: only a change that holds back
 * all later delivery.
 */
export function WritingStatus({ textRef }: { textRef?: string }) {
  return textRef === undefined ? <AccountWritingStatus /> : <TextWritingStatus textRef={textRef} />;
}

function AccountWritingStatus() {
  const writing = useWriting();
  const head = writing.outbox.find(row => row.uncertain && row.blocked !== null);
  if (!head) return null;
  return <FeedbackStatus
    content={{ tone: "Warning", title: "couldn’t confirm a change.", message: "later changes wait until you retry it or review it in notes." }}
    announcement="Polite"
    actions={[{ label: "retry same change", onClick: () => void retryWriting(head.intent_id) }]}
  />;
}

function TextWritingStatus({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  const writing = useWriting();
  if (!text || text.gone || text.writingState === "blocked") return null;
  const status = TEXT_STATUS[text.writingState];
  const handle = textDraft(textRef);
  const parked = text.writingState === "uncertain" && handle !== null
    ? writing.outbox.find(row => row.uncertain && row.blocked !== null && row.authored.some(item => item.draft_id === handle.draft_id))
    : undefined;
  const actions: FeedbackActions | undefined = parked ? [{ label: "retry same change", onClick: () => void retryWriting(parked.intent_id) }] : undefined;
  return <FeedbackStatus
    content={{ ...status, message: status.message === "your draft is kept." && !text.durable ? undefined : status.message }}
    announcement={status.tone === "Warning" ? "Polite" : "None"}
    actions={actions}
  />;
}

/** This tab's branch of a text, when it carries a conflict or refusal decision. */
export function NoteConflict({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  const writing = useWriting();
  const handle = textDraft(textRef);
  const draft = handle && writing.drafts.find(item => item.draft_id === handle.draft_id);
  if (!text || !draft?.conflict) return null;
  const resolve = (decision: "mine" | "saved", shown: ConflictShown) => resolveConflict(textRef, decision, shown);
  // Only a saved version can take the old branch's place after a save as a new note.
  return <DraftDecision draft={draft} resolve={resolve} retire={draft.conflict.saved_value === null ? null : (shown) => resolve("saved", shown)} />;
}

/** Confirmed absence keeps changed writing readable and offers a new identity, never resurrection. */
export function UnavailableTexts({ kind, refs }: { kind: "note" | "page"; refs: readonly string[] }) {
  const writing = useWriting();
  const retained = refs.flatMap(ref => {
    const handle = textDraft(ref);
    const draft = handle && writing.drafts.find(item => item.draft_id === handle.draft_id);
    return handle && draft && (draftIsDirty(draft) || draft.conflict !== null) ? [{ ref, handle, draft }] : [];
  });
  return <>
    <FeedbackNotice content={{ tone: retained.length ? "Warning" : "Neutral", title: `this ${kind} is no longer available.` }} announcement="Polite" />
    {retained.map(({ ref, handle, draft }) => <DraftDecision
      key={draft.draft_id}
      draft={draft}
      outlived
      resolve={() => Promise.reject(new WritingDecisionError("this resource is gone; save its words as a new note"))}
      retire={async (shown) => {
        await discardDraft(handle, { revision: shown.revision });
        setGone(ref);
      }}
    />)}
  </>;
}
