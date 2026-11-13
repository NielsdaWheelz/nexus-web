import { useId, type ReactElement, type ReactNode, type Ref } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./ChoiceField.module.css";
import segments from "./Segments.module.css";
import Tooltip from "./Tooltip";

/**
 * Native selection, including radio-group arrow keys and checkbox space. A `Facet`
 * draws only the exception: unchecked dims and slashes its icon. `help` is a tooltip.
 */
export default function ChoiceField({
  label, checked, onChange, disabled, type = "checkbox", name, value, description, presentation = "Inline", icon, help,
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
  readonly presentation?: "Inline" | "Segment" | "Facet";
  readonly icon?: ReactElement;
  readonly help?: string;
  readonly ref?: Ref<HTMLInputElement>;
  readonly "aria-describedby"?: string;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const classes = {
    Inline: { label: styles.choice, input: undefined, icon: undefined },
    Segment: { label: segments.segment, input: styles.coveringInput, icon: undefined },
    Facet: { label: styles.facet, input: styles.coveringInput, icon: styles.facetIcon },
  }[presentation];
  // a caller's description owns spoken help; the tooltip describes only without one.
  const described = cx(describedBy, description && descriptionId) || undefined;
  return (
    <label className={classes.label} data-indicated={presentation === "Segment" && checked || undefined}>
      <Tooltip text={help ?? ""} disabled={help === undefined} triggerRef={ref} renderTrigger={tooltip =>
        <input {...tooltip} className={classes.input} type={type} name={name} value={value}
          checked={checked} disabled={disabled} aria-labelledby={labelId}
          aria-describedby={described ?? tooltip["aria-describedby"]}
          onChange={(event) => onChange(event.currentTarget.checked)} />}/>
      {icon ? <span className={classes.icon} aria-hidden="true">{icon}</span> : null}
      <span>
        <span id={labelId}>{label}</span>
        {description ? <span id={descriptionId} className={styles.description}>{description}</span> : null}
      </span>
    </label>
  );
}
