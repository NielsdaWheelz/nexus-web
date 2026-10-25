import { useId, type ReactElement, type ReactNode } from "react";
import styles from "./ChoiceField.module.css";

/** Native selection, including radio-group arrow keys and checkbox space.
 *  `Segment` paints one option of a `.segments` track. */
export default function ChoiceField({
  label, checked, onChange, disabled, type = "checkbox", name, value, description, presentation = "Inline", icon,
}: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly type?: "checkbox" | "radio";
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly presentation?: "Inline" | "Segment";
  readonly icon?: ReactElement;
}) {
  const id = useId();
  const segment = presentation === "Segment";
  return (
    <label className={segment ? styles.segment : styles.choice}>
      <input className={segment ? styles.segmentInput : undefined} type={type} name={name} value={value} checked={checked} disabled={disabled} aria-describedby={description ? id : undefined} onChange={(event) => onChange(event.currentTarget.checked)} />
      {icon}
      <span>{label}{description ? <span id={id} className={styles.description}>{description}</span> : null}</span>
    </label>
  );
}
