import type { ChangeEventHandler, ReactNode, Ref } from "react";
import Select, { type SelectSize } from "./Select";
import styles from "./Field.module.css";

/** One visibly labelled native select: Stacked for a pane refinement, Inline for a compact instrument option. */
export default function SelectField({
  layout,
  label,
  id,
  size,
  value,
  disabled,
  onChange,
  ref,
  children,
}: {
  readonly layout: "Stacked" | "Inline";
  readonly label: string;
  readonly id?: string;
  readonly size?: SelectSize;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: ChangeEventHandler<HTMLSelectElement>;
  readonly ref?: Ref<HTMLSelectElement>;
  readonly children: ReactNode;
}) {
  return (
    <label
      className={layout === "Stacked" ? styles.stacked : styles.inline}
      htmlFor={id}
    >
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
}
