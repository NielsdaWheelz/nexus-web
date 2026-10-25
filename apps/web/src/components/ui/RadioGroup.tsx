import { useId } from "react";
import ChoiceField from "./ChoiceField";
import styles from "./ChoiceField.module.css";

export default function RadioGroup({ label, value, choices, onChange, disabled }: {
  readonly label: string;
  readonly value: string;
  readonly choices: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend>{label}</legend>
      <div className={styles.choices}>
        {choices.map((choice) => <ChoiceField key={choice.value} type="radio" name={name} value={choice.value} label={choice.label} disabled={choice.disabled} checked={value === choice.value} onChange={() => onChange(choice.value)} />)}
      </div>
    </fieldset>
  );
}
