"use client";

import Select from "@/components/ui/Select";
import styles from "./SortSelect.module.css";

export default function SortSelect({
  value,
  options,
  onChange,
  label,
  size = "sm",
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  label: string; // accessible name, e.g. "Sort"
  size?: "sm" | "md" | "lg";
}) {
  return (
    <label className={styles.wrap}>
      <span className="sr-only">{label}</span>
      <Select
        size={size}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
