"use client";

// Saving state beside the text; explicit comparison when a newer saved value exists.
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { resolveConflict, useText, type TextValue } from "@/lib/notes/texts";
import { useWriteStatus } from "@/lib/notes/writes";
import styles from "./NoteNotices.module.css";

export function WritingStatus() {
  const status = useWriteStatus();
  if (status !== "retrying") return null;
  return (
    <FeedbackStatus content={{ tone: "Neutral", title: "saving again…" }} announcement="Polite" />
  );
}

const plain = (value: TextValue) => (typeof value === "string" ? value : value.body_text);

export function NoteConflict({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  if (text?.failure && !text.conflict)
    return (
      <FeedbackNotice content={{ tone: "Danger", title: "note change not confirmed", message: "your text remains in this tab. edit it to try saving again.", requestId: text.failure.requestId }} announcement="Polite" />
    );
  if (!text?.conflict) return null;
  const what = typeof text.value === "string" ? "title" : "note";
  return (
    <div className={styles.conflict}>
      <FeedbackNotice content={{ tone: "Warning", title: `this ${what} changed elsewhere` }} announcement="Polite" />
      <dl className={styles.compare}>
        <dt>Yours</dt>
        <dd>{plain(text.value) || "(empty)"}</dd>
        <dt>Saved</dt>
        <dd>{plain(text.conflict.value) || "(empty)"}</dd>
      </dl>
      <div className={styles.actions}>
        <Button size="sm" variant="secondary" onClick={() => resolveConflict(textRef, "mine")}>
          Keep mine
        </Button>
        <Button size="sm" variant="ghost" onClick={() => resolveConflict(textRef, "saved")}>
          Use saved
        </Button>
      </div>
    </div>
  );
}
