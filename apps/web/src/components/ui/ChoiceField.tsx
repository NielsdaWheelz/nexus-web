import { useId, type ReactNode } from "react";
import styles from "./ChoiceField.module.css";

/** Native selection, including radio-group arrow keys and checkbox space. */
export default function ChoiceField({
  label, checked, onChange, disabled, type = "checkbox", name, value, description,
}: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly type?: "checkbox" | "radio";
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
}) {
  const id = useId();
  return (
    <label className={styles.choice}>
      <input type={type} name={name} value={value} checked={checked} disabled={disabled} aria-describedby={description ? id : undefined} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}{description ? <span id={id} className={styles.description}>{description}</span> : null}</span>
    </label>
  );
}
