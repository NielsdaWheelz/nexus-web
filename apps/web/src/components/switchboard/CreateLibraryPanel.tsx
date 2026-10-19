"use client";

import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
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
  const failure = submit.kind === "Ready" ? null : submit.content ?? null;
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
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className="sr-only">{mobile ? "back" : "Back"}</span>
        </button>
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
            onChange={(event) => onName(event.currentTarget.value)}
          />
        </label>
        {failure ? (
          <FeedbackNotice
            content={failure}
            announcement="Assertive"
            actions={[{ label: "retry", onClick: onSubmit, busy: running, disabledReason: !name.trim() ? "enter a library name" : undefined }]}
          />
        ) : <button type="submit" disabled={!name.trim() || running} onClick={submitGesture}>
          {mobile ? running ? "creating…" : "create" : running ? "Creating…" : "Create"}
        </button>}
      </form>
    </div>
  );
}
