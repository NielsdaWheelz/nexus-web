"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import { useThrowLater } from "@/lib/api/serverState";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import type { ChatCommand, CommandOutcome, ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  readonly title: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
  readonly retry?: (intent: OpenIntent) => Promise<void>;
}

interface Observation extends ChatCommandObservation {
  readonly commandKey: string;
}

function commandKey(command: ChatCommand): string | null {
  return command.kind === "DeleteChat" ? `DeleteChat:${command.expectedRevision}`
    : command.kind === "Repeat" ? `Repeat:${command.runId}` : null;
}

/** The action owner projects a continuing write; the chat owner keeps its exact command. */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const fail = useThrowLater();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    if (!input.owner.isActive() || state.kind === "Idle") return;
    const key = commandKey(state.command);
    if (key === null) throw new Error("Action feedback requires a pending chat deletion or repeat");
    const observation: Observation = { ...input, commandKey: key };
    setObservations((current) => [...current.filter((item) => item.id !== input.id), observation]);
  }, []);
  const remove = useCallback((observation: Observation) => {
    setObservations((current) => current.filter((item) => item !== observation));
  }, []);
  return {
    observe,
    feedback: observations.map((observation) => (
      <ChatCommandFeedback key={observation.id} observation={observation} remove={remove} fail={fail} />
    )),
  };
}

function ChatCommandFeedback({ observation, remove, fail }: {
  observation: Observation;
  remove: (observation: Observation) => void;
  fail: (failure: { error: unknown }) => void;
}) {
  const { id, title, owner, commandKey: key, present, retry } = observation;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const current = owner.isActive() && state.kind !== "Idle" && commandKey(state.command) === key;
  const retained = useRef<{ key: string; content: FeedbackContent | null }>({ key, content: null });
  if (retained.current.key !== key) retained.current = { key, content: null };
  if (current && state.feedback !== null) retained.current.content = state.feedback;
  useEffect(() => {
    if (!current) remove(observation);
  }, [current, observation, remove]);
  useWorkspaceCondition(`chat-command:${id}`, current ? {
    priority: "Write",
    announcement: "Polite",
    content: retained.current.content
      ? { ...retained.current.content, message: [title, retained.current.content.message].filter(Boolean).join(" · ") }
      : { tone: "Neutral", title: "checking chat change…", message: title },
    actions: [{
      label: "check chat change",
      commandKey: key,
      busy: state.kind === "Sending" || (state.kind === "Reconciling" && state.feedback === null),
      onClick: (intent) => {
        const latest = owner.getSnapshot();
        if (!owner.isActive() || latest.kind === "Idle" || commandKey(latest.command) !== key) return;
        const checking = retry ? retry(intent) : owner.retry(intent).then((outcome) => {
          if (owner.isActive()) present(outcome);
        });
        void checking.catch((error: unknown) => {
          if (owner.isActive()) fail({ error });
        });
      },
    }],
  } : null);
  return null;
}
