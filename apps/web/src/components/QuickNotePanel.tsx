"use client";

import { useCallback, useState } from "react";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { quickCaptureDailyNote } from "@/lib/notes/api";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import styles from "./AddContentTray.module.css";

export default function QuickNotePanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  const openToday = useCallback(() => {
    onClose();
    requestOpenInAppPane("/daily", { titleHint: "Today" });
  }, [onClose]);

  const submit = useCallback(async () => {
    const bodyMarkdown = text.trim();
    if (!bodyMarkdown) {
      setFeedback({ severity: "error", title: "Write a quick note first." });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await quickCaptureDailyNote({ bodyMarkdown });
      setText("");
      setFeedback({ severity: "success", title: "Added to today." });
    } catch (error: unknown) {
      setFeedback(toFeedback(error, { fallback: "Quick note could not be added." }));
    } finally {
      setBusy(false);
    }
  }, [text]);

  return (
    <>
      <form
        className={styles.quickNoteForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="quick-note-input">Quick note to today</label>
        <Textarea
          id="quick-note-input"
          size="sm"
          className={styles.quickNoteTextarea}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setFeedback(null);
          }}
          rows={5}
          placeholder="Capture a thought..."
        />
        <div className={styles.quickNoteActions}>
          <Button variant="secondary" size="md" onClick={openToday}>
            Open today
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy || !text.trim()}
          >
            {busy ? "Adding..." : "Add note"}
          </Button>
        </div>
      </form>
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </>
  );
}
