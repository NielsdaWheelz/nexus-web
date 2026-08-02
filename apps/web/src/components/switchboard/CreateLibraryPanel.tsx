"use client";

import { ArrowLeft } from "lucide-react";
import type { FormEvent } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ReplayableSubmitState } from "@/lib/nexus/model";
import styles from "./switchboard.module.css";

export default function CreateLibraryPanel({
  name,
  submit,
  onName,
  onBack,
  onSubmit,
}: {
  name: string;
  submit: ReplayableSubmitState;
  onName: (name: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const running = submit.kind === "Running";
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !running) onSubmit();
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className={styles.srOnly}>Back</span>
        </button>
        <h2 tabIndex={-1} data-switchboard-heading>
          New library
        </h2>
      </header>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label>
          Name
          <input
            data-switchboard-library-name
            value={name}
            autoComplete="off"
            disabled={running}
            onChange={(event) => onName(event.currentTarget.value)}
          />
        </label>
        {submit.kind === "Retryable" ? (
          <FeedbackNotice
            content={submit.content}
            announcement="Assertive"
          />
        ) : null}
        <button type="submit" disabled={!name.trim() || running}>
          {running ? "Creating…" : submit.kind === "Retryable" ? "Retry" : "Create"}
        </button>
      </form>
    </div>
  );
}
