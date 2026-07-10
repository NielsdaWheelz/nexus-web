"use client";

import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import type { DocentWalkState } from "@/lib/conversations/docentWalk";
import styles from "./DocentOverlay.module.css";

export default function DocentOverlay({
  walk,
  onNext,
  onPrev,
  onLeave,
}: {
  walk: DocentWalkState;
  onNext: () => void;
  onPrev: () => void;
  onLeave: () => void;
}) {
  if (walk.status !== "active") return null;

  const step = walk.steps[walk.index];
  if (!step) return null;

  return (
    <div
      className={styles.overlay}
      role="status"
      data-testid="docent-overlay"
    >
      <div className={styles.header} aria-live="polite" data-testid="docent-header">
        <span className={styles.counter}>
          {walk.index + 1} / {walk.steps.length}
        </span>
        <span className={styles.sep} aria-hidden="true">·</span>
        <span className={styles.title}>{step.title}</span>
      </div>

      <div className={styles.sentence}>
        {step.href !== null ? (
          step.citingSentence !== null ? (
            <MachineText variant="inline" origin={{ label: "Assistant" }}>
              {step.citingSentence}
            </MachineText>
          ) : (
            <span className={styles.noSentence} aria-hidden="true">
              —
            </span>
          )
        ) : (
          <>
            <s aria-label="Source unavailable">{step.title}</s>
            <span className={styles.unavailable}>Source unavailable</span>
          </>
        )}
      </div>

      <div className={styles.controls}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onPrev}
          disabled={walk.index === 0}
          aria-label="Previous source"
        >
          ← prev
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onNext}
          aria-label="Next source"
        >
          next →
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLeave}
          aria-label="Leave walk"
        >
          ✕ Leave
        </Button>
      </div>
    </div>
  );
}
