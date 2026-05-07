"use client";

import { COLOR_LABELS } from "@/lib/highlights/colors";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights/segmenter";
import styles from "./HighlightColorPicker.module.css";

export default function HighlightColorPicker({
  selectedColor,
  onSelectColor,
  disabled = false,
  disabledColors = [],
  className,
}: {
  selectedColor: HighlightColor;
  onSelectColor: (color: HighlightColor) => void;
  disabled?: boolean;
  disabledColors?: readonly HighlightColor[];
  className?: string;
}) {
  const disabledColorSet = new Set(disabledColors);

  return (
    <div className={`${styles.picker} ${className ?? ""}`.trim()}>
      {HIGHLIGHT_COLORS.map((color) => {
        const isSelected = selectedColor === color;
        const isDisabled = disabled || disabledColorSet.has(color);

        return (
          // Highlight color swatch: the entire visual is the bg color and a thin
          // selected border. This stays bespoke instead of using Button.
          <button
            key={color}
            type="button"
            className={`${styles.colorButton} ${styles[`color-${color}`]} ${
              isSelected ? styles.selected : ""
            }`}
            onClick={() => onSelectColor(color)}
            aria-label={`${COLOR_LABELS[color]}${isSelected ? " (selected)" : ""}`}
            aria-pressed={isSelected}
            disabled={isDisabled}
          />
        );
      })}
    </div>
  );
}
