"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Hold, useResendFeedback } from "@/components/feedback/Feedback";
import ChatOperationBoundary from "@/components/chat/ChatOperationBoundary";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { useLatestWorkspace } from "@/lib/workspace/store";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { changedLine, commandKey, unsureFact, type ChatCommand, type CommandOutcome, type CommandState, type ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
  readonly retry?: (intent: OpenIntent) => Promise<void>;
}
type Observation = ChatCommandObservation & { readonly command: ChatCommand; readonly paneId: string; readonly visitId: string };

/** Mounted projection of an operation raised outside a chat. The owner retains its
 * request and defect; a chat pane, when present, owns the same occurrence's presentation. */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const workspace = useLatestWorkspace();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    const command = state.kind === "Idle" ? input.owner.getDefectCommand() : state.command;
    if (!input.owner.isActive() || command === null) return;
    const current = workspace();
    const pane = current.state.panes.find(pane => pane.id === current.state.active_primary_pane_id)!;
    setObservations(values => [...values.filter(value => value.id !== input.id), { ...input, command, paneId: pane.id, visitId: pane.current_visit.id }]);
  }, [workspace]);
  const remove = useCallback((id: string) => setObservations(values => values.filter(value => value.id !== id)), []);
  return { observe, feedback: observations.map(observation => <PendingCommand key={observation.id} observation={observation} remove={remove} />) };
}

function PendingCommand({ observation, remove }: { observation: Observation; remove(id: string): void }) {
  const { id, owner, present, retry, command } = observation;
  const key = commandKey(command);
  const transportVerbs = useTransportVerbs();
  const resendFeedback = useResendFeedback();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const failure = useSyncExternalStore(owner.subscribe, owner.getDefect, owner.getDefect);
  const failedCommand = owner.getDefectCommand();
  const defect = failedCommand !== null && commandKey(failedCommand) === key ? failure : null;
  const viewed = useSyncExternalStore(owner.subscribe, owner.isViewed, owner.isViewed);
  const current: Exclude<CommandState, { kind: "Idle" }> | null =
    owner.isActive() && state.kind !== "Idle" && commandKey(state.command) === key ? state : null;
  useEffect(() => { if (!current && !defect) remove(id); }, [current, defect, id, remove]);
  const again = useCallback((intent: OpenIntent) => {
    const settling = retry ? retry(intent) : owner.retry(intent).then(outcome => { if (owner.isActive()) present(outcome); });
    void settling.catch((error: unknown) => { if (owner.isActive()) owner.reportDefect(error, command); });
  }, [retry, owner, present, command]);
  useFailedReadRepair(current !== null && !viewed && current.standing?.kind === "Unread", current?.kind === "Busy", () => { void owner.refresh(); });
  if (viewed) return null;
  let line: Line;
  let verbs: Verbs | null;
  const standing = current?.standing;
  const verb = (label: string): CommandVerb => ({ label, commandKey: `${standing?.kind ?? "Defect"} ${key}`, busy: current?.kind === "Busy", run: again });
  if (standing?.kind === "Unknown") ({ line, verbs } = resendFeedback({ line: { fact: unsureFact(command), reason: UNKNOWN_OUTCOME_REASON }, resend: verb("retry") }));
  else if (standing?.kind === "Changed") {
    line = { ...changedLine(command), ...(standing.uncertain ? { reason: unsureFact(command) } : {}) }; verbs = [verb("check")];
  } else if (standing?.kind === "Unread") {
    const transport = transportOf(standing.error);
    line = TRANSPORT_LINES[transport].read("messages"); verbs = transportVerbs(transport, { retry: verb("retry") });
  } else if (defect) {
    line = { fact: "this chat action stopped unexpectedly." };
    verbs = [{ label: "dismiss", commandKey: `dismiss ${key}`, run: () => owner.clearDefect() }];
  } else return null;
  const content = <Hold id={key} attempt={current?.attempt ?? defect?.occurrence ?? 0} line={line} verbs={verbs} />;
  return defect ? <ChatOperationBoundary failure={defect} paneId={observation.paneId} visitId={observation.visitId} fallback={content} /> : content;
}
