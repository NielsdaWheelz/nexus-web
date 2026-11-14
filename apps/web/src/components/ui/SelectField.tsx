import type { ChangeEventHandler, ReactNode, Ref } from "react";
import Select, { type SelectSize } from "./Select";
import styles from "./Field.module.css";

/** One visibly labelled native select for forms. */
export default function SelectField({
  label,
  id,
  size,
  value,
  disabled,
  "aria-describedby": describedBy,
  onChange,
  ref,
  children,
}: {
  readonly label: string;
  readonly id?: string;
  readonly size?: SelectSize;
  readonly value: string;
  readonly disabled?: boolean;
  readonly "aria-describedby"?: string;
  readonly onChange: ChangeEventHandler<HTMLSelectElement>;
  readonly ref?: Ref<HTMLSelectElement>;
  readonly children: ReactNode;
}) {
  return (
    <label
      className={styles.stacked}
      htmlFor={id}
    >
      <span>{label}</span>
      <Select
        ref={ref}
        id={id}
        size={size}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={onChange}
      >
        {children}
      </Select>
    </label>
  );
}
