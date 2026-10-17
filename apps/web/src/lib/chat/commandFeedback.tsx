"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import { useThrowLater } from "@/lib/api/serverState";
import type { CommandOutcome, ConversationCommands } from "./commands";

export interface ChatCommandObservation {
  readonly id: string;
  readonly title: string;
  readonly owner: ConversationCommands;
  readonly present: (outcome: CommandOutcome) => void;
}

interface Observation extends ChatCommandObservation {
  readonly expectedRevision: number;
}

/** The action owner projects continuing deletion; the chat owner keeps its exact command. */
export function useChatCommandFeedback() {
  const [observations, setObservations] = useState<readonly Observation[]>([]);
  const fail = useThrowLater();
  const observe = useCallback((input: ChatCommandObservation) => {
    const state = input.owner.getSnapshot();
    if (!input.owner.isActive() || state.kind === "Idle") return;
    if (state.command.kind !== "DeleteChat")
      throw new Error("Action feedback requires the pending chat deletion");
    const observation: Observation = { ...input, expectedRevision: state.command.expectedRevision };
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
  const { id, title, owner, expectedRevision, present } = observation;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const current = owner.isActive() && state.kind !== "Idle" && state.command.kind === "DeleteChat"
    && state.command.expectedRevision === expectedRevision;
  const retained = useRef<{ expectedRevision: number; content: FeedbackContent | null }>({ expectedRevision, content: null });
  if (retained.current.expectedRevision !== expectedRevision)
    retained.current = { expectedRevision, content: null };
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
      commandKey: `DeleteChat:${expectedRevision}`,
      busy: state.kind === "Sending" || (state.kind === "Reconciling" && state.feedback === null),
      onClick: () => {
        const latest = owner.getSnapshot();
        if (!owner.isActive() || latest.kind === "Idle" || latest.command.kind !== "DeleteChat"
          || latest.command.expectedRevision !== expectedRevision) return;
        void owner.retry().then((outcome) => {
          if (owner.isActive()) present(outcome);
        }).catch((error: unknown) => {
          if (owner.isActive()) fail({ error });
        });
      },
    }],
  } : null);
  return null;
}
