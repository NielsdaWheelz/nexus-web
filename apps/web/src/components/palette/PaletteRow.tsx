"use client";

import { useEffect, useRef } from "react";
import { ChevronRight, X } from "lucide-react";
import { PALETTE_OPTION_ID_PREFIX, type PaletteItem } from "./paletteModel";
import styles from "./palette.module.css";

export default function PaletteRow({
  item,
  selected,
  onSelect,
  onDrill,
  onTrailing,
  onHover,
}: {
  item: PaletteItem;
  selected: boolean;
  onSelect(item: PaletteItem): void;
  onDrill(item: PaletteItem): void;
  onTrailing(item: PaletteItem): void;
  onHover(id: string): void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const Icon = item.icon;
  const ariaLabel = [item.title, item.subtitle, item.shortcutLabel].filter(Boolean).join(" ");

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={rowRef}
      id={`${PALETTE_OPTION_ID_PREFIX}${item.id}`}
      role="option"
      aria-selected={selected}
      aria-label={ariaLabel}
      className={styles.option}
      data-active={selected || undefined}
      onMouseMove={() => onHover(item.id)}
      onClick={() => onSelect(item)}
    >
      <Icon size={16} aria-hidden="true" />
      <span className={styles.optionText}>
        <span className={styles.optionTitle}>{item.title}</span>
        {item.subtitle ? <span className={styles.optionSubtitle}>{item.subtitle}</span> : null}
      </span>
      {item.trailingAction ? (
        <button
          type="button"
          tabIndex={-1}
          className={styles.trailingButton}
          aria-label={item.trailingAction.ariaLabel}
          onClick={(event) => {
            event.stopPropagation();
            onTrailing(item);
          }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      ) : item.hasActions ? (
        <button
          type="button"
          tabIndex={-1}
          className={styles.drill}
          aria-label="Show actions"
          onClick={(event) => {
            event.stopPropagation();
            onDrill(item);
          }}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : item.shortcutLabel ? (
        <span className={styles.keycap}>{item.shortcutLabel}</span>
      ) : null}
    </div>
  );
}
