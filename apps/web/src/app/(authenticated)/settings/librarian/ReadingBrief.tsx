"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Field, useFocusReturn } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import PaneSection from "@/components/ui/PaneSection";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson } from "@/lib/api/wire";
import { usePaneEntryDelivery } from "@/lib/panes/paneRuntime";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { usePaneRevealAnchor } from "@/lib/workspace/paneReturnMemento";
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
  const titleId = useId();
  const helpId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [settled, setSettled] = useState(false);
  const { delivery, claim } = usePaneEntryDelivery();
  const reveal = usePaneRevealAnchor();
  useEffect(() => {
    const input = field.current;
    if (profile === null || !input || delivery?.entry.kind !== "FocusReadingBrief" || !claim(delivery)) return;
    reveal("librarian-settings", "reading-brief", false);
    input.focus({ preventScroll: true });
  }, [profile, delivery, claim, reveal]);
  const draft = useResourceDraft<{ text: string | null; command: Command | null; refusal: string | null }>(
    "Settings.ReadingBrief", () => ({ text: null, command: null, refusal: null }),
    value => ({ changed: value.text !== null && value.text !== (profile?.reading_brief ?? ""), unconfirmed: value.command !== null, stopsBrowserWork: false }),
    value => value.text,
  );
  const value = draft.value.text ?? profile?.reading_brief ?? "";
  const command = draft.value.command;
  const differs = value !== (profile?.reading_brief ?? "");
  const left = 8_000 - Array.from(value).length;
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
      setSettled(draft.read().text === null);
      publishChange("Chats");
    } catch (error) {
      if (draft.read().command !== submitted) return;
      const uncertain = old !== null || outcomeUnknown(error);
      const retained = uncertain ? { ...submitted, busy: false, attempt: submitted.attempt + 1 } : null;
      if (isApiError(error) && error.status === 409) {
        draft.set(value => ({ ...value, command: retained, refusal: "the reading brief changed. review your draft and save again." }));
        reload();
      } else if (isApiError(error) && error.code === "E_INVALID_REQUEST") {
        draft.set(value => ({ ...value, command: retained, refusal: "use at most 8,000 characters." }));
      } else {
        draft.set(value => ({ ...value, command: retained }));
        if (!outcomeUnknown(error)) fail(error, "couldn’t save the reading brief.");
      }
    }
  }
  const held = command !== null && command.attempt > 0 ? resendFeedback({
    line: { fact: "not sure the reading brief saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: "save reading brief", busy: command.busy, run: () => void save() },
  }) : null;
  return <PaneSection title={<span id={titleId}>reading brief</span>} data-pane-return-scope="librarian-settings" data-collection-row-id="reading-brief">
    <form className={styles.briefForm} onSubmit={event => { event.preventDefault(); if (command === null && differs) void save(); }}>
      {held && command ? <Hold id={`${draft.owner}:save`} attempt={command.attempt} {...held} /> : null}
      <div className={styles.briefRail}>
        <Textarea bare autoGrow={{ minRows: 5, maxRows: 24 }} className={styles.briefInput} ref={field} value={value}
          disabled={profile === null} aria-labelledby={titleId} aria-describedby={`${helpId}${draft.value.refusal ? ` ${errorId}` : ""}`}
          placeholder="early modern history, decision-making, and fiction; less productivity advice."
          data-settled={settled && !differs || undefined} onAnimationEnd={() => setSettled(false)}
          onKeyDown={event => {
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.repeat) return;
            event.preventDefault();
            if (command === null && differs) void save();
          }}
          onChange={event => {
            setSettled(false);
            draft.set(value => ({ ...value, text: event.target.value, refusal: null }));
          }} />
      </div>
      <p id={helpId} className={styles.note}>what you want to learn, pursue, or avoid. the librarian uses this when answering and choosing reading.</p>
      {draft.value.refusal ? <Field id={errorId} line={{ fact: draft.value.refusal }} /> : null}
      <div className={styles.briefFoot}>
        <span className={styles.count}>{left <= 800 ? left < 0 ? `${-left} over` : `${left} left` : null}</span>
        <div className={styles.verbSlot}>
          {differs ? <BriefVerbs field={field} busy={command?.busy ?? false} blocked={profile === null || command !== null}
            revert={() => { setSettled(false); draft.set(value => ({ ...value, text: null, refusal: null })); }} /> : null}
        </div>
      </div>
    </form>
  </PaneSection>;
}

/** The withdrawing verbs return their own focus to the brief. */
function BriefVerbs({ field, busy, blocked, revert }: {
  field: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  blocked: boolean;
  revert(): void;
}) {
  const root = useRef<HTMLSpanElement>(null);
  useFocusReturn(root, () => field.current);
  return <span ref={root} className={styles.verbs}>
    <Button onClick={revert}>revert</Button>
    <Button type="submit" emphasis="strong" aria-disabled={blocked} aria-busy={busy || undefined}>save</Button>
  </span>;
}
