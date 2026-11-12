"use client";

import { useId } from "react";
import { Field } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import PaneSection from "@/components/ui/PaneSection";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import styles from "./page.module.css";

type Profile = ApiJson<"/me", "get">["data"];
type Command = { text: string; version: string; busy: boolean; attempt: number };

/** A saved brief is an absolute versioned value; uncertain retry retains its bytes. */
export default function ReadingBrief({ profile, onSaved, reload }: {
  profile: Profile | null;
  onSaved(profile: Profile): void;
  reload(): void;
}) {
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const fieldId = useId();
  const draft = useResourceDraft<{ text: string | null; command: Command | null; refusal: string | null }>(
    "Settings.ReadingBrief", () => ({ text: null, command: null, refusal: null }),
    value => ({ changed: value.text !== null && value.text !== (profile?.reading_brief ?? ""), unconfirmed: value.command !== null, stopsBrowserWork: false }),
    value => value.text,
  );
  const value = draft.value.text ?? profile?.reading_brief ?? "";
  const command = draft.value.command;
  async function save() {
    if (profile === null || draft.read().command?.busy) return;
    const old = draft.read().command;
    const submitted: Command = { text: old?.text ?? value, version: old?.version ?? profile.reading_brief_version, busy: true, attempt: old?.attempt ?? 0 };
    draft.set(value => ({ ...value, command: submitted, refusal: null }));
    try {
      const { data } = await apiFetch<ApiJson<"/me", "patch">>("/api/me", {
        method: "PATCH", body: JSON.stringify({ reading_brief: submitted.text.trim() ? submitted.text : null, expected_reading_brief_version: submitted.version }),
      });
      if (draft.read().command !== submitted) return;
      draft.set(value => ({ text: value.text === submitted.text ? null : value.text, command: null, refusal: null }));
      onSaved(data);
      publishChange("Chats");
    } catch (error) {
      if (draft.read().command !== submitted) return;
      if (outcomeUnknown(error)) draft.set(value => ({ ...value, command: { ...submitted, busy: false, attempt: submitted.attempt + 1 } }));
      else if (isApiError(error) && error.status === 409) {
        draft.set(value => ({ ...value, command: null, refusal: "the reading brief changed. review your draft and save again." }));
        reload();
      } else if (isApiError(error) && error.code === "E_INVALID_REQUEST") {
        draft.set(value => ({ ...value, command: null, refusal: "use at most 8,000 characters." }));
      } else {
        draft.set(value => ({ ...value, command: old === null ? null : { ...submitted, busy: false, attempt: submitted.attempt + 1 } }));
        fail(error, "couldn’t save the reading brief.");
      }
    }
  }
  const held = command !== null && command.attempt > 0 ? resendFeedback({
    line: { fact: "not sure the reading brief saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: "save reading brief", busy: command.busy, run: () => void save() },
  }) : null;
  return <PaneSection title="reading brief">
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (command === null) void save(); }}>
      {held && command ? <Hold id={`${draft.owner}:save`} attempt={command.attempt} {...held} /> : null}
      <label className={styles.field}><span className={styles.label}>reading brief</span>
        <Textarea value={value} disabled={profile === null} aria-describedby={fieldId}
          onChange={event => draft.set(value => ({ ...value, text: event.target.value, refusal: null }))} />
      </label>
      <p id={fieldId} className={styles.current}>what you want to learn, pursue, or avoid. the librarian uses this when answering and choosing reading.</p>
      {draft.value.refusal ? <Field id={`${fieldId}-error`} line={{ fact: draft.value.refusal }} /> : null}
      <Button type="submit" emphasis="strong" disabled={profile === null || command !== null || value === (profile.reading_brief ?? "")} aria-busy={command?.busy || undefined}>save reading brief</Button>
    </form>
  </PaneSection>;
}
