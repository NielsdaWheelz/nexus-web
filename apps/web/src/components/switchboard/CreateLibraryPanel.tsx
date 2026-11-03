"use client";
import * as Icon from "@/lib/ui/icons";
import { useId, type FormEvent } from "react";
import Button from "@/components/ui/Button";
import { Field } from "@/components/feedback/Fact";
import { Hold, useTransportVerbs } from "@/components/feedback/Feedback";
import { TRANSPORT_LINES, transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { ReplayableSubmitState } from "@/lib/nexus/model";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./Switchboard.module.css";

export default function CreateLibraryPanel({
  name,
  submit,
  onName,
  onBack,
  onSubmit,
  mobile,
}: {
  name: string;
  submit: ReplayableSubmitState;
  onName: (name: string) => void;
  onBack: () => void;
  onSubmit: (intent: OpenIntent) => void;
  mobile: boolean;
}) {
  const transportVerbs = useTransportVerbs();
  const running = submit.kind === "Running";
  const failed = submit.kind === "Running" || submit.kind === "Retryable" ? submit : null;
  const failure = failed?.failure ?? null;
  const fieldId = useId();
  // A refusal stands under the name, and `create` is its retry. A transport's verb is the
  // transport's own: reload for a stale build. The inputs are disabled while it runs, so focus
  // leaves them: each refusal speaks once as it lands, keyed by its failure.
  const transport = failure?.kind === "Transport" ? transportOf(failure.error) : null;
  const refusal = failure?.kind === "Refused" ? failure.line
    : failure?.kind === "Transport" && transport !== null ? TRANSPORT_LINES[transport].command(failure.fact) : null;
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !running) onSubmit("default");
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      if (name.trim() && !running) onSubmit(activation.intent);
    }
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Button iconOnly icon={<Icon.Left />} className={styles.iconButton} aria-label={mobile ? "back" : "Back"} onClick={onBack} />
        <h2 tabIndex={-1} data-switchboard-heading>
          {mobile ? "new library" : "New library"}
        </h2>
      </header>
      <form className={styles.form} onSubmit={handleSubmit} onKeyDown={submitGesture}>
        <label>
          {mobile ? "name" : "Name"}
          <input
            data-switchboard-library-name
            value={name}
            autoComplete="off"
            disabled={running}
            aria-describedby={refusal ? fieldId : undefined}
            onChange={(event) => onName(event.currentTarget.value)}
          />
        </label>
        {refusal ? <Field id={fieldId} line={refusal} verbs={transport ? transportVerbs(transport) ?? undefined : undefined} /> : null}
        {failure?.kind === "Unknown" ? <Hold id="create-library" attempt={failed?.failures} line={{ fact: "not sure the library was created.", reason: UNKNOWN_OUTCOME_REASON }} /> : null}
        <Button emphasis="strong" type="submit" aria-busy={running || undefined}
          disabled={!name.trim() || running} onClick={submitGesture}>{mobile ? "create" : "Create"}</Button>
      </form>
    </div>
  );
}
