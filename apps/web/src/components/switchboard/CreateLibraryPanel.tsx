"use client";

import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import Button from "@/components/ui/Button";
import { FeedbackFailure, FeedbackRecoveryControl, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import type { ReplayableSubmitState } from "@/lib/nexus/model";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "@/components/nexus/Nexus.module.css";

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
  const running = submit.kind === "Running";
  const failure = submit.kind === "Ready" || submit.kind === "Acknowledged" ? null : submit.content ?? null;
  const occurrence = useFeedbackOccurrence(failure !== null, name);
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
        <Button iconOnly icon={<ArrowLeft />} className={styles.iconButton} aria-label={mobile ? "back" : "Back"} onClick={onBack} />
        <h2 tabIndex={-1} data-switchboard-heading>
          {mobile ? "new library" : "New library"}
        </h2>
        <FeedbackRecoveryControl />
      </header>
      <form className={styles.form} onSubmit={handleSubmit} onKeyDown={submitGesture}>
        <label>
          {mobile ? "name" : "Name"}
          <input
            data-switchboard-library-name
            value={name}
            autoComplete="off"
            disabled={running}
            onChange={(event) => onName(event.currentTarget.value)}
          />
        </label>
        {failure ? <FeedbackFailure scope="Local" occurrence={occurrence}
          content={failure} announcement="Assertive"
          actions={[{ label: "retry same request", onClick: onSubmit, busy: running, disabledReason: !name.trim() ? "enter a library name" : undefined }]} /> : null}
        <Button reserveIcon busyKey={occurrence} emphasis="strong" type="submit" aria-busy={running || undefined}
          disabled={!name.trim() || running} onClick={submitGesture}>{mobile ? "create" : "Create"}</Button>
      </form>
    </div>
  );
}
