"use client";

import styles from "./MessageRow.module.css";

export default function StreamingGutterCue() {
  return (
    <div
      className={styles.streamingCue}
      data-testid="streaming-cue"
      aria-hidden="true"
    />
  );
}
