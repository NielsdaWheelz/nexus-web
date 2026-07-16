"use client";

import { useEffect } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useReaderContext } from "./ReaderContext";
import { toReaderProfileSaveErrorMessage } from "./readerProfileSync";

/**
 * The keyed dedupe identity of the one reader-profile save-failure
 * presentation. An active Settings pane suppresses it and presents inline;
 * everywhere else it is a persistent global notice.
 */
export const READER_PROFILE_SAVE_FEEDBACK_KEY = "reader-profile-save";

/**
 * The global presentation owner for reader-profile persistence: SaveFailed
 * keeps one persistent notice with Retry, Forbidden one without, and leaving
 * failure (new intent or success) permanently clears it. Renders nothing.
 */
export function ReaderProfileSaveFeedback() {
  const { persistence, retrySave } = useReaderContext();
  const { show, dismissByDedupeKey } = useFeedback();

  useEffect(() => {
    if (persistence.state === "SaveFailed" || persistence.state === "Forbidden") {
      show({
        severity: "error",
        ...toReaderProfileSaveErrorMessage(persistence.failure),
        dedupeKey: READER_PROFILE_SAVE_FEEDBACK_KEY,
        duration: 0,
        ...(persistence.state === "SaveFailed"
          ? { action: { label: "Retry", onClick: retrySave } }
          : {}),
      });
      return;
    }
    dismissByDedupeKey(READER_PROFILE_SAVE_FEEDBACK_KEY);
  }, [dismissByDedupeKey, persistence, retrySave, show]);

  return null;
}
