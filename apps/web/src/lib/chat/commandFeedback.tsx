"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useThrowLater } from "@/lib/api/serverState";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import type { ChatCommand, CommandOutcome, ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  readonly title: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
  /** The action's own retry, which lands its result; else the owner retries and `present` answers. */
  readonly retry?: (intent: OpenIntent) => Promise<void>;
}
type Observation = ChatCommandObservation & { readonly commandKey: string };

const commandKey = (command: ChatCommand) =>
  command.kind === "DeleteChat" ? `DeleteChat:${command.expectedRevision}`
  : command.kind === "Repeat" ? `Repeat:${command.runId}` : null;

/** A menu's chat deletion or repeat outlives its menu. While its exact command stays
 * pending, each failed attempt reports once with its check; the conversation pane
 * shows a repeat's recovery itself, and the menu re-sends a deletion. */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const fail = useThrowLater();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    if (!input.owner.isActive() || state.kind === "Idle") return;
    const key = commandKey(state.command);
    if (key === null) throw new Error("Action feedback requires a pending chat deletion or repeat");
    setObservations((current) => [...current.filter((item) => item.id !== input.id), { ...input, commandKey: key }]);
  }, []);
  const remove = useCallback((id: string) => setObservations((current) => current.filter((item) => item.id !== id)), []);
  return {
    observe,
    feedback: observations.map((observation) => (
      <PendingCommand key={observation.id} observation={observation} remove={remove} fail={fail} />
    )),
  };
}

function PendingCommand({ observation, remove, fail }: {
  observation: Observation;
  remove: (id: string) => void;
  fail: (failure: { error: unknown }) => void;
}) {
  const { id, title, owner, commandKey: key, present, retry } = observation;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const current = owner.isActive() && state.kind !== "Idle" && commandKey(state.command) === key ? state : null;
  useEffect(() => {
    if (!current) remove(id);
  }, [current, id, remove]);
  const feedback = useFeedback();
  useEffect(() => {
    // A check in flight keeps the earlier failure; only a settled failure reports, until it changes.
    if (!current?.feedback || current.kind === "Busy") return;
    return feedback.receipt({ ...current.feedback, message: [title, current.feedback.message].filter(Boolean).join(" · ") }, {
      label: "check chat change",
      onClick: (intent) => {
        if (owner.getSnapshot() !== current) return;
        const checking = retry ? retry(intent) : owner.retry(intent).then((outcome) => owner.isActive() && present(outcome));
        void checking.catch((error: unknown) => owner.isActive() && fail({ error }));
      },
    });
  }, [current, feedback, fail, owner, present, retry, title]);
  return null;
}
