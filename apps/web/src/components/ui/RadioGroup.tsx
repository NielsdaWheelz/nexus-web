import { useId, type ReactElement, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import ChoiceField from "./ChoiceField";
import styles from "./ChoiceField.module.css";

/** Native exclusive choice: one fieldset, its radios sharing one name. */
export default function RadioGroup<V extends string>({
  label, value, choices, onChange, disabled, description, presentation = "Inline", legend = "Visible",
  "aria-describedby": describedBy,
}: {
  readonly label: string;
  readonly value: V;
  readonly choices: readonly { readonly value: V; readonly label: ReactNode; readonly icon?: ReactElement; readonly disabled?: boolean }[];
  readonly onChange: (value: V) => void;
  readonly disabled?: boolean;
  readonly description?: string;
  readonly presentation?: "Inline" | "Segmented";
  readonly legend?: "Visible" | "Hidden";
  readonly "aria-describedby"?: string;
}) {
  const name = useId();
  const descriptionId = useId();
  const segmented = presentation === "Segmented";
  return (
    <fieldset className={cx(styles.group, segmented && styles.segmented)} disabled={disabled}
      aria-describedby={cx(describedBy, description && descriptionId) || undefined}>
      <legend className={legend === "Hidden" ? "sr-only" : undefined}>{label}</legend>
      <div className={segmented ? styles.segments : styles.choices}>
        {choices.map((choice) => <ChoiceField key={choice.value} type="radio" name={name} value={choice.value} label={choice.label} icon={choice.icon} disabled={choice.disabled} presentation={segmented ? "Segment" : "Inline"} checked={value === choice.value} onChange={() => onChange(choice.value)} />)}
      </div>
      {description ? <p id={descriptionId} className={styles.groupDescription}>{description}</p> : null}
    </fieldset>
  );
}
