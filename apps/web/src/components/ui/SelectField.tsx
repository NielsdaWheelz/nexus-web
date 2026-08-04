"use client";

import { forwardRef, type ChangeEventHandler, type ReactNode } from "react";
import Select, { type SelectSize } from "@/components/ui/Select";
import styles from "./SelectField.module.css";

/** Stacked labels a pane refinement control; Inline labels a compact instrument option. */
type SelectFieldLayout = "Stacked" | "Inline";

const layoutClass: Record<SelectFieldLayout, string> = {
  Stacked: styles.stacked,
  Inline: styles.inline,
};

/** One visibly labelled native select. Presentational: the caller owns the options. */
const SelectField = forwardRef<
  HTMLSelectElement,
  {
    readonly layout: SelectFieldLayout;
    readonly label: string;
    readonly id?: string;
    readonly size?: SelectSize;
    readonly value: string;
    readonly disabled?: boolean;
    readonly onChange: ChangeEventHandler<HTMLSelectElement>;
    readonly children: ReactNode;
  }
>(function SelectField(
  { layout, label, id, size, value, disabled, onChange, children },
  ref,
) {
  return (
    <label className={layoutClass[layout]} htmlFor={id}>
      <span>{label}</span>
      <Select
        ref={ref}
        id={id}
        size={size}
        value={value}
        disabled={disabled}
        onChange={onChange}
      >
        {children}
      </Select>
    </label>
  );
});

export default SelectField;
