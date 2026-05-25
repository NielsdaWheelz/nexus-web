"use client";

import { useEffect, useRef } from "react";
import type { PaletteCommand } from "./types";
import styles from "./PaletteBody.module.css";

interface PaletteRowProps {
  command: PaletteCommand;
  selected: boolean;
  showTag: boolean;
  showShortcut: boolean;
  onSelect(command: PaletteCommand): void;
  onHover?(commandId: string): void;
}

const SECTION_TAGS: Record<string, string> = {
  "open-tabs": "Tab",
  recent: "Recent",
  "recent-folios": "Folio",
  create: "Create",
  navigate: "Go to",
  settings: "Settings",
};

function tagFor(command: PaletteCommand): string | null {
  const tag = SECTION_TAGS[command.sectionId];
  if (tag) return tag;
  if (command.source === "search" && command.subtitle) return command.subtitle;
  return null;
}

export default function PaletteRow({
  command,
  selected,
  showTag,
  showShortcut,
  onSelect,
  onHover,
}: PaletteRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const Icon = command.icon;
  const tag = showTag ? tagFor(command) : null;
  const optionName = [
    command.title,
    command.subtitle,
    tag,
    showShortcut ? command.shortcutLabel : undefined,
    command.disabled?.reason,
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={rowRef}
      id={`palette-option-${command.id}`}
      role="option"
      aria-selected={selected ? "true" : "false"}
      aria-label={optionName}
      aria-disabled={command.disabled ? "true" : undefined}
      className={styles.option}
      data-active={selected ? "true" : "false"}
      data-disabled={command.disabled ? "true" : "false"}
      onMouseMove={() => onHover?.(command.id)}
      onClick={() => {
        if (!command.disabled) onSelect(command);
      }}
    >
      <Icon size={16} aria-hidden="true" />
      <span className={styles.optionText}>
        <span className={styles.optionTitle}>{command.title}</span>
        {command.subtitle ? (
          <span className={styles.optionSubtitle}>{command.subtitle}</span>
        ) : null}
      </span>
      {command.disabled ? (
        <span className={styles.optionMeta}>{command.disabled.reason}</span>
      ) : tag ? (
        <span className={styles.tag}>{tag}</span>
      ) : showShortcut && command.shortcutLabel ? (
        <span className={styles.optionMeta}>{command.shortcutLabel}</span>
      ) : null}
    </div>
  );
}
