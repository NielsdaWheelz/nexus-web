"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Hold } from "@/components/feedback/Feedback";
import { transportVerbs, type CommandVerb } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { useThrowLater } from "@/lib/api/serverState";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { commandKey, MAY_HAVE, unsureFact, type CommandOutcome, type CommandState, type ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  /** Until L7: the caller's label. The held line names the title the viewer confirmed. */
  readonly title: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
  /** Until L7: a menu repeat's own retry. Its conversation pane holds a repeat. */
  readonly retry?: (intent: OpenIntent) => Promise<void>;
}
type Observation = ChatCommandObservation & { readonly commandKey: string };

/** A menu's chat deletion outlives its menu: while its exact command stays pending, it holds a
 * slip at the workspace. Every other command is held by its conversation pane. */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const fail = useThrowLater();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    if (!input.owner.isActive() || state.kind === "Idle" || state.command.kind !== "DeleteChat") return;
    const key = commandKey(state.command);
    setObservations((current) => [...current.filter((item) => item.id !== input.id), { ...input, commandKey: key }]);
  }, []);
  const remove = useCallback((id: string) => setObservations((current) => current.filter((item) => item.id !== id)), []);
  return {
    observe,
    feedback: observations.map((observation) => (
      <PendingDeletion key={observation.id} observation={observation} remove={remove} fail={fail} />
    )),
  };
}

function PendingDeletion({ observation, remove, fail }: {
  observation: Observation;
  remove: (id: string) => void;
  fail: (failure: { error: unknown }) => void;
}) {
  const { id, owner, commandKey: key, present } = observation;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const current: Exclude<CommandState, { kind: "Idle" }> | null =
    owner.isActive() && state.kind !== "Idle" && commandKey(state.command) === key ? state : null;
  useEffect(() => {
    if (!current) remove(id);
  }, [current, id, remove]);
  if (current === null || current.standing === null || current.command.kind !== "DeleteChat") return null;
  const { standing, command } = current;
  // Unknown resends the frozen deletion: a gone chat settles. Changed reads the chat; Unread reads it again.
  const verb: CommandVerb = {
    label: standing.kind === "Changed" ? "check" : "retry",
    commandKey: `${standing.kind} ${key}`,
    busy: current.kind === "Busy",
    run: (intent: OpenIntent) => {
      if (owner.getSnapshot() !== current || current.kind === "Busy") return;
      void owner.retry(intent).then(outcome => owner.isActive() && present(outcome))
        .catch((error: unknown) => owner.isActive() && fail({ error }));
    },
  };
  const refused = `couldn’t delete “${command.title}”.`;
  const transport = standing.kind === "Unread" ? transportOf(standing.error) : null;
  const line = standing.kind === "Unknown" ? { fact: unsureFact(command), reason: MAY_HAVE }
    : transport === null ? { fact: refused, reason: "it changed meanwhile." }
    : TRANSPORT_LINES[transport].command(refused);
  // a stale build offers reload alone
  const verbs = transport === null ? [verb] as const : transportVerbs(transport, { retry: verb, signIn: null }) ?? undefined;
  return <Hold id={`${key}:${standing.kind}`} attempt={current.attempt} line={line} verbs={verbs} />;
}
