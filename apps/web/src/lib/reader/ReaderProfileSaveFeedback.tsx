"use client";

import { useEffect, useRef } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useReaderContext } from "./ReaderContext";
import { toReaderProfileSaveErrorMessage } from "./readerProfileSync";

/**
 * The keyed dedupe identity of the one persistent reader-profile save-failure
 * notice.
 */
const READER_PROFILE_SAVE_FEEDBACK_KEY = "reader-profile-save";

/**
 * The global presentation owner for reader-profile persistence: SaveFailed
 * keeps one persistent notice with Retry, and leaving failure (new intent or
 * success) permanently clears it. Renders nothing.
 */
export function ReaderProfileSaveFeedback() {
  const { persistence, retrySave } = useReaderContext();
  const { publish, resolve } = useFeedback();

  // A persistent action may outlive the failure render that published it; a
  // Retry click after state already left SaveFailed is "too late", not a defect.
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;

  useEffect(() => {
    if (persistence.state === "SaveFailed") {
      publish({
        kind: "Persistent",
        key: READER_PROFILE_SAVE_FEEDBACK_KEY,
        content: {
          tone: "Danger",
          ...toReaderProfileSaveErrorMessage(persistence.failure),
        },
        announcement: "Assertive",
        actions: [
          {
            label: "Retry",
            onClick: () => {
              if (persistenceRef.current.state === "SaveFailed") {
                retrySave();
              }
            },
          },
        ],
      });
      return;
    }
    resolve(READER_PROFILE_SAVE_FEEDBACK_KEY);
  }, [persistence, publish, resolve, retrySave]);

  return null;
}
