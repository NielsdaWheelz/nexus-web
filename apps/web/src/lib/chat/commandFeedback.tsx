"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
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

/** A menu's chat deletion or repeat outlives its menu: its pending command stays a workspace condition. */
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
      <Condition key={observation.id} observation={observation} remove={remove} fail={fail} />
    )),
  };
}

function Condition({ observation, remove, fail }: {
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
  useWorkspaceCondition(`chat-command:${id}`, current ? {
    needsAttention: current.feedback !== null,
    priority: "Write",
    announcement: "Polite",
    content: current.feedback
      ? { ...current.feedback, message: [title, current.feedback.message].filter(Boolean).join(" · ") }
      : { tone: "Neutral", title: "checking chat change…", message: title },
    actions: [{
      label: "check chat change",
      commandKey: key,
      busy: current.kind === "Busy",
      onClick: (intent) => {
        if (owner.getSnapshot() !== current) return;
        const checking = retry ? retry(intent) : owner.retry(intent).then((outcome) => owner.isActive() && present(outcome));
        void checking.catch((error: unknown) => owner.isActive() && fail({ error }));
      },
    }],
  } : null);
  return null;
}
