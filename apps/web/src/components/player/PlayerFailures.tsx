"use client";

import { FeedbackFailure, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import * as Player from "@/lib/player/playerRuntime";

export const unavailableMessages = {
  UpdateRequired: "update nexus for android",
  NotResponding: "player unavailable",
} satisfies Record<Extract<Player.PlayerState, { kind: "Unavailable" }>["reason"], string>;

/** One account-level presentation identity over the existing player state owners. */
export function usePlayerFailurePresentation() {
  const {preferences, playbackFailure, queueFailureOccurrence, state, queue} = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const unavailableOccurrence = useFeedbackOccurrence(state.kind === "Unavailable");
  const applicationFailure = preferences?.application.kind === "Failed" ? preferences.application
    : preferences?.application.kind === "Applying" ? preferences.application.failure : null;
  return <>
    {state.kind === "Unavailable" && state.reason === "NotResponding" ? <FeedbackFailure scope="Local" occurrence={unavailableOccurrence} content={{tone: "Warning", title: unavailableMessages[state.reason]}} announcement="Polite" /> : null}
    {playbackFailure !== null ? <FeedbackFailure scope="Local" occurrence={playbackFailure.occurrence} content={{tone: "Warning", title: playbackFailure.message}}
      announcement="Polite" actions={[{label: "retry", onClick: commands.resume, busy: state.kind === "Loaded" && state.phase === "Buffering"}]} /> : null}
    {applicationFailure ? <FeedbackFailure scope="Local" occurrence={applicationFailure.occurrence}
      content={{tone: "Warning", title: "couldn’t apply playback settings", message: applicationFailure.message}}
      announcement="Polite" actions={[{label: "try again", onClick: commands.retryPlaybackPreferences, busy: preferences?.application.kind === "Applying"}]} /> : null}
    {queue.error !== null ? <FeedbackFailure scope="Local" occurrence={queueFailureOccurrence} content={{tone: "Warning", title: queue.error}}
      announcement="Polite" actions={[{label: "check playback", onClick: commands.checkQueue, busy: queue.phase === "Preparing" || queue.phase === "Saving"}]} /> : null}
  </>;
}

/** Every player surface shows the action runtime's one presentation, never its own copy. */
export function PlayerFailures() {
  return useActionRuntime().playerFeedback;
}
