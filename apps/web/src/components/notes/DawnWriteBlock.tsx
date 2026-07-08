"use client";

import { useState } from "react";
import MachineText, { type MachineSignatureTime } from "@/components/ui/MachineText";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { dismissDawnWrite, type DawnWrite } from "@/lib/notes/api";
import styles from "./DawnWriteBlock.module.css";

interface DawnWriteBlockProps {
  write: DawnWrite;
}

export default function DawnWriteBlock({ write }: DawnWriteBlockProps) {
  const display = useRenderEnvironment();
  const [dismissed, setDismissed] = useState(write.dismissed_at !== null);

  if (dismissed) return null;

  const displayTime = formatDisplayDate(write.generated_at, display, {
    hour: "numeric",
    minute: "2-digit",
  });
  const signature: MachineSignatureTime = displayTime
    ? { timestamp: displayTime, timestampIso: write.generated_at }
    : {};

  const handleDismiss = () => {
    setDismissed(true);
    void dismissDawnWrite(write.id).catch(() => {
      // Server failure on dismiss is silent — the block will reappear on next
      // page load (dismissed_at remains null). Acceptable over showing an error
      // state for a throw-away action (D-6).
    });
  };

  return (
    <div className={styles.dawnWriteShell} data-testid="dawn-write-block">
      <MachineText
        origin={{ label: "Dawn" }}
        {...signature}
        variant="block"
        data-testid="dawn-write-machine"
      >
        <MarkdownMessage content={write.body_md} />
      </MachineText>
      <button
        className={styles.dismissButton}
        onClick={handleDismiss}
        aria-label="Dismiss dawn write"
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}
