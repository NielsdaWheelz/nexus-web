"use client";

import styles from "./LecternNextPrompt.module.css";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";

/**
 * A single quiet line offered at the end of a document: "Next on the lectern:
 * <title>". Explicit tap only — no auto-advance (N-2). Presentational; the owner
 * supplies the tap behavior (remove finished item + open the next entry).
 */
export default function LecternNextPrompt({
  title,
  onSelect,
}: {
  title: string;
  onSelect: (intent: OpenIntent) => void;
}) {
  const activate = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Open") onSelect(activation.intent);
  };
  return (
    <button type="button" className={styles.prompt} onClick={activate} onKeyDown={activate}>
      Next on the lectern: <span className={styles.title}>{title}</span>
    </button>
  );
}
