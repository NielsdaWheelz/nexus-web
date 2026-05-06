"use client";

import { useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { truncateText } from "@/lib/conversations/display";
import type { ForkOption } from "@/lib/conversations/types";
import styles from "./ForkStrip.module.css";

export default function ForkStrip({
  forks,
  switchableLeafIds,
  onSelectFork,
}: {
  forks: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork: (fork: ForkOption) => void;
}) {
  const visibleForks = useMemo(
    () =>
      switchableLeafIds
        ? forks.filter((fork) => switchableLeafIds.has(fork.leaf_message_id))
        : forks,
    [forks, switchableLeafIds],
  );
  const initialIndex = Math.max(
    0,
    visibleForks.findIndex((fork) => fork.active),
  );
  const [focusedIndex, setFocusedIndex] = useState(initialIndex);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (visibleForks.length < 2) return null;

  const focusButton = (index: number) => {
    setFocusedIndex(index);
    buttonRefs.current[index]?.focus();
  };

  const moveFocus = (index: number) => {
    const nextIndex = Math.max(0, Math.min(visibleForks.length - 1, index));
    focusButton(nextIndex);
  };

  return (
    <section className={styles.strip} aria-label="Forks from this answer">
      <div className={styles.header}>
        <GitBranch size={14} aria-hidden="true" />
        <span>{forks.length} forks</span>
      </div>
      <div className={styles.list}>
        {visibleForks.map((fork, index) => {
          const title = fork.title || truncateText(fork.preview, 72);
          const date = dateLabel(fork.created_at);
          const label = forkAccessibleLabel(fork, date);
          return (
            <button
              key={fork.id}
              ref={(element) => {
                buttonRefs.current[index] = element;
              }}
              type="button"
              className={styles.item}
              data-active={fork.active ? "true" : "false"}
              aria-current={fork.active ? "true" : undefined}
              aria-label={label}
              tabIndex={index === focusedIndex ? 0 : -1}
              onFocus={() => setFocusedIndex(index)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "ArrowLeft":
                    event.preventDefault();
                    moveFocus(index - 1);
                    break;
                  case "ArrowRight":
                    event.preventDefault();
                    moveFocus(index + 1);
                    break;
                  case "Home":
                    event.preventDefault();
                    focusButton(0);
                    break;
                  case "End":
                    event.preventDefault();
                    focusButton(visibleForks.length - 1);
                    break;
                  case "Enter":
                  case " ":
                    event.preventDefault();
                    onSelectFork(fork);
                    break;
                }
              }}
              onClick={() => onSelectFork(fork)}
            >
              <span className={styles.itemTitle}>{title}</span>
              <span className={styles.reply}>{truncateText(fork.preview, 96)}</span>
              {fork.branch_anchor_preview ? (
                <span className={styles.anchor}>
                  {truncateText(fork.branch_anchor_preview, 96)}
                </span>
              ) : null}
              <span className={styles.meta}>
                {fork.active ? "Current - " : ""}
                {fork.status} - {fork.message_count} messages{date ? ` - ${date}` : ""}
              </span>
              <span className={styles.leafMeta}>
                Leaf {truncateText(fork.leaf_message_id, 12)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function forkAccessibleLabel(fork: ForkOption, date: string): string {
  const parts = [
    fork.active ? "Current fork" : "Switch to fork",
    fork.title ? `Title: ${fork.title}` : null,
    `Reply: ${fork.preview}`,
    fork.branch_anchor_preview ? `Quote: ${fork.branch_anchor_preview}` : null,
    `Status: ${fork.status}`,
    `Messages: ${fork.message_count}`,
    date ? `Created: ${date}` : null,
  ];
  return parts.filter(Boolean).join(". ");
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
