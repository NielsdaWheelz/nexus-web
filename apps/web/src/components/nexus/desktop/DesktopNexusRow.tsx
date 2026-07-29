"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { desktopNexusOptionId } from "./DesktopNexusInput";
import type { DesktopNexusController, DesktopNexusEntry } from "./types";
import styles from "./desktopNexus.module.css";

export default function DesktopNexusRow({
  entry,
  selected,
  nested = false,
  controller,
}: {
  entry: DesktopNexusEntry;
  selected: boolean;
  nested?: boolean;
  controller: DesktopNexusController;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    controller.selectEntry(
      entry.key,
      event.shiftKey ? "Fork" : "Follow",
      "Pointer",
    );
  };
  const secondary = [entry.typeLabel, entry.metadata, entry.open ? "Open" : undefined]
    .filter(Boolean)
    .join(" · ");
  const excerpt = entry.excerptSegments?.map((segment) => segment.text).join("") ?? entry.excerpt;

  return (
    <div
      ref={rowRef}
      id={desktopNexusOptionId(entry.key)}
      role="option"
      aria-selected={selected}
      aria-label={[entry.label, secondary, excerpt].filter(Boolean).join(". ")}
      className={styles.option}
      data-active={selected || undefined}
      data-nested={nested || undefined}
      onMouseMove={() => controller.setActiveEntry(entry.key)}
      onClick={activate}
    >
      <span className={styles.icon} aria-hidden="true">{entry.icon}</span>
      <span className={styles.optionBody}>
        <span className={styles.optionLabel}>{entry.label}</span>
        {secondary ? <span className={styles.optionMeta}>{secondary}</span> : null}
        {excerpt ? (
          <span className={styles.optionExcerpt}>
            {entry.excerptSegments
              ? entry.excerptSegments.map((segment, index) =>
                segment.emphasized ? (
                  <mark key={index} className={styles.optionExcerptMatch}>
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )
              : entry.excerpt}
          </span>
        ) : null}
      </span>
    </div>
  );
}
