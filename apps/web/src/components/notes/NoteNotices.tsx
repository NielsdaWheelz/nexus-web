"use client";

// Notices describe live saves. Rich comparisons preserve the exact versions
// reviewed; local memory is never presented as a successful save.
import { DOMSerializer } from "prosemirror-model";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus, useFeedback, type FeedbackActions, type FeedbackContextValue } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { useWritingRefresh } from "@/lib/api/writingReceive";
import { noteBodySchema } from "@/lib/notes/noteBody";
import { readWriting, subscribeWriting, WritingDecisionError, type ConflictShown } from "@/lib/notes/writes";
import { resolveConflict, retryText, textWrite, useText, type TextValue } from "@/lib/notes/texts";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import styles from "./NoteNotices.module.css";

export function useWriting() {
  return useSyncExternalStore(subscribeWriting, readWriting, readWriting);
}

export function copyWriting(feedback: FeedbackContextValue, text: string): void {
  void copyText(text).catch((error: unknown) => {
    if (!(error instanceof ClipboardWriteUnavailableError)) { reportError(error); return; }
    feedback.offer({ key: "writing-copy", announcement: "Polite", content: { tone: "Warning", title: "copy unavailable", message: "select the text and copy it before leaving." } });
  });
}

function plain(value: TextValue): string { return typeof value === "string" ? value : value.body_text; }
function RichValue({ value }: { value: TextValue }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (typeof value === "string") return;
    const block = noteBodySchema.nodeFromJSON(value.body_pm_json);
    host.current!.replaceChildren(DOMSerializer.fromSchema(noteBodySchema).serializeNode(block));
  }, [value]);
  return typeof value === "string" ? <p className={styles.plain}>{value || "(empty)"}</p> : <div ref={host} className={styles.rich} />;
}

export function TextComparison({ value, saved, before = null, shown, resolve, subject = "note" }: {
  value: TextValue; saved: TextValue; before?: TextValue | null; shown: ConflictShown; subject?: "note" | "page title";
  resolve: (decision: "mine" | "saved", shown: ConflictShown) => Promise<void>;
}) {
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);
  const decide = (decision: "mine" | "saved") => {
    if (busy) return;
    setBusy(true);
    void resolve(decision, shown).catch((error: unknown) => {
      if (!(error instanceof WritingDecisionError)) reportError(error);
      feedback.offer({ key: "writing-choice", announcement: "Polite", content: { tone: "Warning", title: "couldn’t apply this choice", message: error instanceof WritingDecisionError ? error.message : "review the current versions before trying again." } });
    }).finally(() => setBusy(false));
  };
  const entries = [...(before === null ? [] : [{ label: "before", value: before }]), { label: "your changes", value }, { label: "saved", value: saved }];
  return <div className={styles.conflict}>
    <FeedbackNotice content={{ tone: "Warning", title: `this ${subject} changed elsewhere`, message: "review both versions before saving." }} announcement="Polite" />
    <dl className={styles.compare}>{entries.map(entry => <div key={entry.label} className={styles.compareRow}>
      <dt>{entry.label}</dt><dd><RichValue value={entry.value} /></dd>
    </div>)}</dl>
    {plain(value) === plain(saved) && JSON.stringify(value) !== JSON.stringify(saved) ? <p className={styles.formatting}>only the formatting differs.</p> : null}
    <div className={styles.actions}>
      <Button disabled={busy} onClick={() => decide("saved")}>use saved version</Button>
      <Button disabled={busy} onClick={() => decide("mine")}>replace saved version</Button>
    </div>
  </div>;
}

export function WritingRefreshNotice({ textRef, kind }: { textRef: string; kind: "note" | "title" }) {
  const { error, retry } = useWritingRefresh(textRef);
  if (error === null) return null;
  const title = `this ${kind} couldn’t refresh.`;
  return <FeedbackNotice content={{ ...(apiTransportFeedback(error, title) ?? { tone: "Warning", title }), requestId: error.requestId }}
    announcement="Polite" actions={[{ label: "try again", onClick: retry }]} />;
}

export function WritingStatusLine({ content, announcement, actions }: {
  content: { tone: "Neutral" | "Warning"; title: string; message?: string };
  announcement: "None" | "Polite"; actions?: FeedbackActions;
}) {
  return <>
    <FeedbackStatus content={{ tone: content.tone, title: content.title }} announcement={announcement} actions={actions} />
    {content.message ? <p className={styles.instruction}>{content.message}</p> : null}
  </>;
}

export function WritingStatus({ textRef }: { textRef?: string }) {
  return textRef === undefined ? null : <TextWritingStatus textRef={textRef} />;
}
function TextWritingStatus({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  const feedback = useFeedback();
  if (!text || text.gone || text.conflict) return null;
  const copy = () => copyWriting(feedback, plain(text.value));
  if (text.failure?.irreducible) return <WritingStatusLine content={{ tone: "Warning", title: "save not confirmed",
    message: "copy changes you want to keep, then reload. other unsaved changes will be lost." }} announcement="Polite"
    actions={[{ label: "copy text", onClick: copy }, { label: "reload", onClick: () => { window.location.reload(); } }]} />;
  if (text.writingState === "uncertain") return <WritingStatusLine content={{ tone: "Warning", title: "save not confirmed", message: "the request may have succeeded." }} announcement="Polite"
    actions={[{ label: "retry same save", onClick: () => retryText(textRef) }, { label: "copy text", onClick: copy }]} />;
  if (text.failure) {
    const error = text.failure.error;
    return <FeedbackNotice content={{ tone: "Warning", title: "couldn’t save this note",
      message: isApiError(error) ? error.message : "review your changes before saving again.", requestId: text.failure.requestId }} announcement="Polite"
      actions={[{ label: "copy text", onClick: copy }]} />;
  }
  return text.writingState === "saving" || textWrite(textRef) !== null ? <WritingStatusLine content={{ tone: "Neutral", title: "saving…" }} announcement="None" /> : null;
}

export function NoteConflict({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  const feedback = useFeedback();
  if (!text) return null;
  if (text.gone) return <FeedbackNotice content={{ tone: "Warning", title: "this note was deleted", message: "copy any changes you want to keep." }} announcement="Polite"
    actions={[{ label: "copy text", onClick: () => copyWriting(feedback, plain(text.value)) }]} />;
  const conflict = text.conflict;
  if (!conflict) return null;
  return <TextComparison subject={textRef.startsWith("page:") ? "page title" : "note"} value={text.value} saved={conflict.value} before={text.acked?.value ?? null}
    shown={{ revision: text.revision, saved_version: conflict.origin === "server" ? conflict.version : text.acked?.version ?? null }}
    resolve={(choice, shown) => resolveConflict(textRef, choice, shown)} />;
}

export function UnavailableTexts({ kind, refs }: { kind: "note" | "page"; refs: readonly string[] }) {
  return <>
    <FeedbackNotice content={{ tone: "Warning", title: `this ${kind} is no longer available`, message: "copy any changes you want to keep." }} announcement="Polite" />
    {refs.map(ref => <UnavailableText key={ref} textRef={ref} />)}
  </>;
}
function UnavailableText({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  const feedback = useFeedback();
  if (!text) return null;
  return <div className={styles.conflict}><RichValue value={text.value} /><Button onClick={() => copyWriting(feedback, plain(text.value))}>copy text</Button></div>;
}
