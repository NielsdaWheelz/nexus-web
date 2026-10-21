"use client";

// Recover writing: this account's journal branches, reachable without the pane that
// made them. Each row names its destination, its latest state and the next decision.
// Opening a destination never submits. A decision claims the branch in this tab and
// is refused while another tab owns it; old-version rows can only be downloaded or
// discarded, never decoded. Every dirty, unsent or conflicted branch is listed,
// whoever owns it: a closed pane's text owner may still hold its lease.
import { useEffect, useRef, useState } from "react";
import { FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import {
  claimDraft,
  discardDraft,
  discardIncompatible,
  draftIsDurable,
  releaseDraft,
  resolveDraftConflict,
  retireWriting,
  retryWriting,
  WritingDecisionError,
  type ConflictShown,
  type DraftHandle,
  type DraftSnapshot,
  type OutboxRow,
  type WritingSnapshot,
} from "@/lib/notes/journal";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { Schema } from "@/lib/api/wire";
import { resolveConflict, textDraft } from "@/lib/notes/texts";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import {
  copyWriting,
  draftIsDirty,
  draftSubject,
  draftText,
  DraftDecision,
  refusalTitle,
  downloadWriting,
  useOnline,
  useWriting,
} from "./NoteNotices";
import styles from "./NoteNotices.module.css";

function rowsOf(writing: WritingSnapshot, draft: DraftSnapshot): OutboxRow[] {
  return writing.outbox.filter(row => row.authored.some(item => item.draft_id === draft.draft_id));
}

function needsDecision(writing: WritingSnapshot, draft: DraftSnapshot): boolean {
  return draft.conflict !== null ||
    rowsOf(writing, draft).some(row => row.blocked !== null) ||
    (writing.storage_error !== null && !draftIsDurable(draft.draft_id));
}

function recoverable(writing: WritingSnapshot, draft: DraftSnapshot): boolean {
  return needsDecision(writing, draft) || rowsOf(writing, draft).length > 0 || draftIsDirty(draft);
}

function refHref(ref: string): string | null {
  const separator = ref.indexOf(":");
  const kind = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  switch (kind) {
    case "note_block": return `/notes/${id}`;
    case "page": return `/pages/${id}`;
    case "media": return `/media/${id}`;
    default: return null;
  }
}

/** Where an unpublished note will be placed: its insertion's source. */
function sourceHref(source: Schema<"InsertNote">["source"]): string | null {
  switch (source.kind) {
    case "resource": return refHref(source.ref);
    case "passage": return refHref(source.candidate_ref);
    case "fragment_selection": return null;
    case "pdf_selection": return `/media/${source.media_id}`;
    case "daily_page": return `/daily/${source.local_date}`;
  }
}

/** Where the branch's editor lives; unpublished pages and captures open their destination. */
function draftHref(draft: DraftSnapshot): string | null {
  const context = draft.context;
  switch (context.kind) {
    case "body":
      if (context.publication?.kind === "page") return `/pages/${context.publication.request.id}`;
      if (context.publication?.kind === "insert_note") return sourceHref(context.publication.request.source) ?? refHref(context.resource_ref);
      if (context.publication?.kind === "capture") return `/daily/${context.publication.local_date}`;
      if (context.publication?.kind === "passage") return `/media/${context.publication.media_id}`;
      return refHref(context.resource_ref);
    case "composer":
      return sourceHref(context.publication.request.source) ?? refHref(context.resource_ref);
    case "title":
      if (context.publication?.kind === "insert_note") return sourceHref(context.publication.request.source) ?? refHref(context.resource_ref);
      return refHref(context.resource_ref);
    case "capture":
      return `/daily/${context.local_date}`;
    case "passage":
      return `/media/${context.media_id}`;
    case "reference":
      return context.resource_ref === null ? null : refHref(context.resource_ref);
  }
}

function excerpt(text: string): string {
  const line = text.split("\n").find(item => item.trim() !== "")?.trim() ?? "";
  const points = Array.from(line);
  return points.length > 120 ? `${points.slice(0, 119).join("")}…` : line || "(empty)";
}

function rowState(writing: WritingSnapshot, draft: DraftSnapshot, online: boolean): { title: string; message?: string; tone: "Neutral" | "Warning" } {
  const subject = draftSubject(draft);
  const kept = draftIsDurable(draft.draft_id);
  const rows = rowsOf(writing, draft);
  if (!kept) return { tone: "Warning", title: "recent changes are only in this tab.", message: "keep it open or download your writing." };
  const uncertain = rows.find(row => row.uncertain);
  if (uncertain) return { tone: "Warning", title: "couldn’t confirm this change.", message: uncertain.blocked === null ? "your draft is kept. trying again." : "your draft is kept. later changes wait until you retry or stop it." };
  if (draft.conflict !== null)
    return draft.conflict.saved_value === null
      ? { tone: "Warning", title: refusalTitle(draft.conflict.reason, subject), message: "your draft is kept. review it." }
      : { tone: "Warning", title: draft.conflict.other_draft_id === null ? `this ${subject} changed elsewhere.` : `another draft of this ${subject} is open.`, message: "your draft is kept. review it." };
  const blocked = rows.find(row => row.blocked !== null)?.blocked;
  if (blocked) return { tone: "Warning", title: refusalTitle(blocked.code, subject), message: "your draft is kept. review it." };
  if (rows.length > 0) return { tone: "Neutral", title: online ? "saved on this device · syncing" : "saved on this device · offline" };
  return { tone: "Neutral", title: "draft saved on this device" };
}

/** A decision the journal refused leaves everything as it was. */
function refused(feedback: ReturnType<typeof useFeedback>, key: string, error: unknown): void {
  if (!(error instanceof WritingDecisionError)) throw error;
  feedback.offer({ key, announcement: "Polite", content: { tone: "Warning", title: "couldn’t apply this choice.", message: error.message } });
}

function DraftRow({ draft, writing }: { draft: DraftSnapshot; writing: WritingSnapshot }) {
  const online = useOnline();
  const runtime = requirePaneRuntime(usePaneRuntime(), "WritingRecovery");
  const feedback = useFeedback();
  const [review, setReview] = useState<DraftHandle | null>(null);
  // One claim at a time; a claim granted after this row left is released at once.
  const claimed = useRef<DraftHandle | "claiming" | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (claimed.current !== null && claimed.current !== "claiming") void releaseDraft(claimed.current);
      claimed.current = null;
    };
  }, []);
  const state = rowState(writing, draft, online);
  const decision = needsDecision(writing, draft);
  const href = draftHref(draft);
  const rows = rowsOf(writing, draft);
  const parked = rows.find(row => row.uncertain && row.blocked !== null);
  const elsewhere = () => feedback.offer({
    key: `recovery-owner:${draft.draft_id}`,
    announcement: "Polite",
    content: { tone: "Neutral", title: "this draft is open in another tab.", message: "review it there, or close that tab first." },
  });
  const claim = async (): Promise<DraftHandle | null> => {
    const handle = await claimDraft(draft.draft_id);
    if (handle === null) elsewhere();
    return handle;
  };
  const startReview = () => {
    if (claimed.current !== null) return;
    claimed.current = "claiming";
    void claim().then(handle => {
      if (handle === null || !live.current) {
        if (handle !== null) void releaseDraft(handle);
        if (live.current) claimed.current = null;
        return;
      }
      claimed.current = handle;
      setReview(handle);
    }, (error: unknown) => {
      if (live.current) claimed.current = null;
      throw error;
    });
  };
  const endReview = () => {
    if (claimed.current !== null && claimed.current !== "claiming") void releaseDraft(claimed.current);
    claimed.current = null;
    setReview(null);
  };
  const discard = () => {
    // The revision this row shows; anything newer by the time of the delete is kept.
    const shown = { revision: draft.revision };
    if (!window.confirm("discard this draft? its words are removed from this device.")) return;
    void claim().then(async handle => {
      if (handle === null) return;
      try {
        await discardDraft(handle, shown);
      } finally {
        await releaseDraft(handle);
      }
    }).catch((error: unknown) => refused(feedback, `recovery-discard:${draft.draft_id}`, error));
  };
  const stop = (row: OutboxRow) => {
    if (!window.confirm("stop retrying this change? an earlier attempt may still finish. your draft is kept.")) return;
    void retireWriting(row.intent_id).catch((error: unknown) => refused(feedback, `recovery-stop:${row.intent_id}`, error));
  };
  const resolve = (handle: DraftHandle, choice: "mine" | "saved", shown: ConflictShown) => {
    // A text owner in this tab keeps its editors in step with the decision.
    const ref = draft.resource_ref;
    return ref !== null && textDraft(ref)?.draft_id === draft.draft_id
      ? resolveConflict(ref, choice, shown)
      : resolveDraftConflict(handle, choice, shown);
  };

  const open = (event: TargetActivationEvent) => {
    if (href !== null) activateTargetLink({ event, runtime, target: { href } });
  };
  return <li className={styles.row}>
    <p className={styles.label}>{draftSubject(draft)}{draft.context.kind === "capture" ? ` · ${draft.context.local_date}` : ""}</p>
    <p className={styles.excerpt}>{excerpt(draftText(draft.value))}</p>
    <FeedbackStatus content={state} announcement="None" />
    <div className={styles.actions}>
      {href !== null ? <Button size="sm" variant="ghost" asChild>
        <a href={href} data-workspace-rich-target="true" onClick={open} onKeyDown={open}>open</a>
      </Button> : null}
      {parked ? <Button size="sm" variant="ghost" onClick={() => void retryWriting(parked.intent_id)}>retry same change</Button> : null}
      {parked ? <Button size="sm" variant="ghost" onClick={() => stop(parked)}>stop retrying</Button> : null}
      {decision && review === null ? <Button size="sm" variant="secondary" onClick={startReview}>review</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => copyWriting(feedback, draftText(draft.value))}>copy text</Button>
      {review === null ? <Button size="sm" variant="ghost" onClick={discard}>discard</Button> : <Button size="sm" variant="ghost" onClick={endReview}>done</Button>}
    </div>
    {review !== null && decision ? <DraftDecision
      draft={draft}
      resolve={(choice, shown) => resolve(review, choice, shown)}
      // After a save as a new note the old branch takes the saved version, or goes.
      retire={draft.conflict !== null && draft.conflict.saved_value !== null ? (shown) => resolve(review, "saved", shown) : (shown) => discardDraft(review, { revision: shown.revision })}
    /> : null}
  </li>;
}

/** The notes index's `recover writing` entry: count, rows and the account's one file. */
export default function WritingRecovery() {
  const writing = useWriting();
  const feedback = useFeedback();
  const { accountId } = useAuthenticatedAccount();
  const drafts = writing.drafts.filter(draft => recoverable(writing, draft));
  const count = drafts.length + writing.incompatible.length;
  if (count === 0) return null;
  const urgent = writing.incompatible.length > 0 || drafts.some(draft => needsDecision(writing, draft));
  const discardOld = () => {
    if (!window.confirm("discard writing saved by another version of nexus? it can’t be recovered afterwards.")) return;
    void discardIncompatible().catch((error: unknown) => refused(feedback, "recovery-discard-old", error));
  };
  return <details className={styles.recovery} open={urgent}>
    <summary>recover writing · {count}</summary>
    <ul className={styles.rows}>
      {drafts.map(draft => <DraftRow key={draft.draft_id} draft={draft} writing={writing} />)}
      {writing.incompatible.map((envelope, index) => <li key={`incompatible:${index}`} className={styles.row}>
        <p className={styles.label}>{envelope.recovery_label}</p>
        <p className={styles.excerpt}>{excerpt(envelope.recovery_text)}</p>
        <FeedbackStatus content={{ tone: "Warning", title: "saved by another version of nexus.", message: "it can’t be sent from here. copy or download it to keep it." }} announcement="None" />
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={() => copyWriting(feedback, envelope.recovery_text)}>copy text</Button>
        </div>
      </li>)}
    </ul>
    <div className={styles.actions}>
      <Button size="sm" variant="secondary" onClick={() => downloadWriting(feedback, accountId)}>download writing</Button>
      {writing.incompatible.length > 0 ? <Button size="sm" variant="ghost" onClick={discardOld}>discard old-version writing</Button> : null}
    </div>
  </details>;
}
