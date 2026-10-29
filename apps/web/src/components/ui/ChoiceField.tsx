import { useId, type ReactElement, type ReactNode, type Ref } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./ChoiceField.module.css";
import selection from "./Selection.module.css";

/** Native selection, including radio-group arrow keys and checkbox space. */
export default function ChoiceField({
  label, checked, onChange, disabled, type = "checkbox", name, value, description, presentation = "Inline", icon,
  ref, "aria-describedby": describedBy,
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
  readonly ref?: Ref<HTMLInputElement>;
  readonly "aria-describedby"?: string;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const segment = presentation === "Segment";
  return (
    <label className={segment ? cx(styles.segment, selection.surface, selection.target, checked && selection.selected) : styles.choice}>
      <input ref={ref} className={segment ? styles.segmentInput : undefined} type={type} name={name} value={value}
        checked={checked} disabled={disabled} aria-labelledby={labelId}
        aria-describedby={cx(describedBy, description && descriptionId) || undefined}
        onChange={(event) => onChange(event.currentTarget.checked)} />
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>
        <span id={labelId}>{label}</span>
        {description ? <span id={descriptionId} className={styles.description}>{description}</span> : null}
      </span>
    </label>
  );
}
