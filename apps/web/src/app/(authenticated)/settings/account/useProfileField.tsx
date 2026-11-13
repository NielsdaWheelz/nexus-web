"use client";

import type { ReactNode } from "react";
import { Hold, useResendFeedback } from "@/components/feedback/Feedback";
import type { Line } from "@/components/feedback/stage";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { assertNever } from "@/lib/assertNever";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";

export type Outcome =
  | { readonly kind: "Saved" }
  | { readonly kind: "Refused"; readonly line: Line }
  | { readonly kind: "Unknown" }
  | { readonly kind: "Told" };

type Command = { value: string | null; phase: "Sending" | "Unknown" | "Retrying"; attempt: number };

/** submitted intent survives edits and refusals until acceptance settles it. */
export function useProfileField(input: {
  key: "Name" | "Email" | "Zone";
  saved: string | null;
  normalize(text: string): string | null;
  save(value: string | null): Promise<Outcome>;
}): {
  draft: string | null;
  phase: "Idle" | Command["phase"];
  refusal: Line | null;
  edit(text: string): void;
  revert(): void;
  commit(value: string | null): void;
  hold: ReactNode;
} {
  const resendFeedback = useResendFeedback();
  const draft = useResourceDraft<{ text: string | null; command: Command | null; refusal: Line | null }>(
    `Settings.Account.${input.key}`,
    () => ({ text: null, command: null, refusal: null }),
    value => ({
      changed: value.text !== null && input.normalize(value.text) !== input.saved,
      unconfirmed: value.command !== null,
      stopsBrowserWork: false,
    }),
  );
  const command = draft.value.command;
  async function send(value: string | null, retry: boolean) {
    const previous = draft.read().command;
    if (retry ? previous?.phase !== "Unknown" : previous !== null) return;
    const running: Command = {
      value: previous === null ? value : previous.value,
      phase: previous === null ? "Sending" : "Retrying",
      attempt: previous?.attempt ?? 0,
    };
    draft.set(value => ({ ...value, command: running, refusal: null }));
    const result = await input.save(running.value);
    if (draft.read().command !== running) return;
    if (result.kind === "Saved") draft.set(value => ({
      text: value.text !== null && input.normalize(value.text) !== running.value ? value.text : null,
      command: null,
      refusal: null,
    }));
    else if (result.kind === "Unknown" || previous !== null) draft.set(value => ({
      ...value, command: { ...running, phase: "Unknown", attempt: running.attempt + 1 },
    }));
    else if (result.kind === "Refused" || result.kind === "Told") draft.set(value => ({ ...value, command: null, refusal: result.kind === "Refused" ? result.line : null }));
    else assertNever(result);
  }
  const held = command === null || command.phase === "Sending" ? null : resendFeedback({
    line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: `RetryProfile:${input.key}`, busy: command.phase === "Retrying", run: () => { void send(command.value, true); } },
  });
  return {
    draft: draft.value.text,
    phase: command?.phase ?? "Idle",
    refusal: draft.value.refusal,
    edit: (text: string) => draft.set(value => ({ ...value, text, refusal: null })),
    revert: () => draft.set(value => ({ ...value, text: null, refusal: null })),
    commit: (value: string | null) => { void send(value, false); },
    hold: held === null || command === null ? null : <Hold id={`${draft.owner}:profile`} attempt={command.attempt} {...held} />,
  };
}
