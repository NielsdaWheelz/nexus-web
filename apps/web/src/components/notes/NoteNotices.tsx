"use client";

// What saving says: a chip while writes back off, a hud and a lasting "Not saved" when
// the server refuses a save for good, and a text's conflict (keep mine or use saved).
import { useEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { resolveConflict, setTextFailureReporter, useText, type TextValue } from "@/lib/notes/texts";
import { useWriteStatus } from "@/lib/notes/writes";
import styles from "./NoteNotices.module.css";

export function WritingStatus() {
  const status = useWriteStatus();
  const feedback = useFeedback();
  useEffect(
    () =>
      setTextFailureReporter((error) => {
        if (handleUnauthenticatedApiError(error)) return;
        const requestId = isApiError(error) ? error.requestId : undefined;
        const message = "Your text is still here; edit it to try again.";
        const content = { tone: "Danger", title: "Not saved", message, requestId } as const;
        feedback.publish({ kind: "Hud", content });
      }),
    [feedback],
  );
  if (status !== "retrying") return null;
  return (
    <span className={styles.status} role="status">
      Unsaved — retrying
    </span>
  );
}

const plain = (value: TextValue) => (typeof value === "string" ? value : value.body_text);

export function NoteConflict({ textRef }: { textRef: string }) {
  const text = useText(textRef);
  if (text?.failed && !text.conflict)
    return (
      <p className={styles.title} role="status">
        Not saved — edit to try again
      </p>
    );
  if (!text?.conflict) return null;
  const what = typeof text.value === "string" ? "title" : "note";
  return (
    <div className={styles.conflict} role="alert">
      <p className={styles.title}>This {what} changed elsewhere</p>
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
