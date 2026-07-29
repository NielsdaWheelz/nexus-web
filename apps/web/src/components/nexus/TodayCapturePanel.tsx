"use client";

import { useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import NoteBodyEditor from "@/components/notes/NoteBodyEditor";
import {
  FeedbackNotice,
  toFeedback,
} from "@/components/feedback/Feedback";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import Button from "@/components/ui/Button";
import type { NexusTarget } from "@/lib/nexus/model";
import type { TodayCaptureSessionController } from "./useTodayCaptureSession";
import styles from "./TodayCapturePanel.module.css";

export default function TodayCapturePanel({
  onOpen,
  onBack,
  session,
}: {
  onOpen: (target: NexusTarget) => void;
  onBack: () => void;
  session: TodayCaptureSessionController;
}): React.ReactElement {
  const openToday = useCallback(() => {
    session.flush();
    onOpen({ kind: "OpenToday" });
  }, [onOpen, session]);

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.backHeader}
        onClick={onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        <span>New note</span>
      </button>
      <div className={styles.quickNoteForm}>
        <div className={styles.quickNoteEditor}>
          <NoteBodyEditor
            resourceKey={session.editorResourceKey}
            initialBodyPmJson={session.initialBody.bodyPmJson}
            fallbackBodyText={session.initialBody.bodyText}
            ariaLabel="Quick note to today"
            compact
            onBodyChange={session.scheduleSave}
            onBlurFlush={session.flush}
            onFeedback={session.setFeedback}
            onError={(error) => {
              if (handleUnauthenticatedApiError(error)) return;
              session.setFeedback(
                toFeedback(error, {
                  fallback: "Attachment could not be added.",
                }),
              );
            }}
          />
        </div>
        <NoteDraftRecovery
          status={session.saveStatus}
          hasRecoveredDraft={session.hasRecoveredDraft}
          onRetry={session.retry}
          onDiscard={session.discardDraft}
        />
        <div className={styles.quickNoteActions}>
          <Button variant="secondary" size="md" onClick={openToday}>
            Open today
          </Button>
        </div>
      </div>
      {session.feedback ? (
        <FeedbackNotice feedback={session.feedback} />
      ) : null}
    </div>
  );
}
