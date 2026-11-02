"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Hold } from "@/components/feedback/Feedback";
import { transportVerbs, type CommandVerb, type Line, type Verbs } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { useFailedReadRepair, useThrowLater } from "@/lib/api/serverState";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { changedLine, commandKey, MAY_HAVE, unsureFact, type CommandOutcome, type CommandState, type ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  /** Until L7: the caller's label. A held line names its command, and a deletion the title the viewer confirmed. */
  readonly title: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
  /** The surface's own retry, which lands its result; else the owner retries and `present` answers. */
  readonly retry?: (intent: OpenIntent) => Promise<void>;
}
type Observation = ChatCommandObservation & { readonly commandKey: string };

/** A command raised outside a conversation pane (a menu's deletion or repeat, the reader's send)
 * outlives the surface that raised it. While its exact command stays pending it is held here, at
 * the workspace, unless a pane shows its chat: that pane holds it then (Conversation). */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const fail = useThrowLater();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    if (!input.owner.isActive() || state.kind === "Idle") return;
    const key = commandKey(state.command);
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
  const { id, owner, commandKey: key, present, retry } = observation;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const viewed = useSyncExternalStore(owner.subscribe, owner.isViewed, owner.isViewed);
  const current: Exclude<CommandState, { kind: "Idle" }> | null =
    owner.isActive() && state.kind !== "Idle" && commandKey(state.command) === key ? state : null;
  useEffect(() => {
    if (!current) remove(id);
  }, [current, id, remove]);
  // Unknown resends the frozen command: a resend is admitted once, and a gone chat settles. Changed
  // reads the chat; Unread reads it again.
  const again = useCallback((intent: OpenIntent) => {
    const settling = retry ? retry(intent) : owner.retry(intent).then((outcome) => { if (owner.isActive()) present(outcome); });
    void settling.catch((error: unknown) => owner.isActive() && fail({ error }));
  }, [retry, owner, present, fail]);
  // reads wake: a failed read after the command reads again on focus and reconnection
  useFailedReadRepair(current !== null && !viewed && current.standing?.kind === "Unread", current?.kind === "Busy", () => again("default"));
  if (current === null || current.standing === null || viewed) return null;
  const { standing, command } = current;
  const verb = (label: string): CommandVerb => ({
    label,
    commandKey: `${standing.kind} ${key}`,
    busy: current.kind === "Busy",
    run: (intent: OpenIntent) => { if (owner.getSnapshot() === current && current.kind !== "Busy") again(intent); },
  });
  const held = (line: Line, verbs: Verbs | undefined) => <Hold id={`${key}:${standing.kind}`} attempt={current.attempt} line={line} verbs={verbs} />;
  switch (standing.kind) {
    case "Unknown":
      return held({ fact: unsureFact(command), reason: MAY_HAVE }, command.kind === "Send"
        ? [verb("retry"), { label: "discard send", commandKey: `discard ${key}`, run: () => owner.discard() }]
        : [verb("retry")]);
    case "Changed":
      return held(changedLine(command), [verb("check")]);
    case "Unread": {
      // the command was answered; the read that follows it failed, so this is a read's line
      const transport = transportOf(standing.error);
      const noun = command.kind === "DeleteChat" ? `“${command.title}”’s messages` : "messages";
      return held(TRANSPORT_LINES[transport].read(noun), transportVerbs(transport, { retry: verb("retry"), signIn: null }) ?? undefined);
    }
  }
}
