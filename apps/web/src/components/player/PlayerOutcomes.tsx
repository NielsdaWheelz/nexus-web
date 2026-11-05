"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import type { Verbs } from "@/components/feedback/stage";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { remoteAdmission, remoteAttemptAllowed, subscribeAdmission } from "@/lib/native/admission";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import * as Player from "@/lib/player/playerRuntime";

export default function PlayerOutcomes() {
  const { state, queue, playbackSubject } = Player.usePlayerSession();
  const commands = Player.usePlayerCommands();
  const { say } = useOutcome();
  const androidShell = useAndroidShell();
  useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  const resendFeedback = useResendFeedback();
  const admitted = remoteAttemptAllowed();
  const loaded = state.kind === "Loaded" ? state : null;
  const title = loaded?.source.descriptor.title ?? null;
  const episode = loaded?.source.descriptor.media_id ?? null;
  const place = loaded?.error ?? null;
  const failed = loaded?.playbackFailed ? playbackSubject : null;
  const unread = place?.kind === "Unread" ? place.attempt : null;
  const coordination = queue.error?.kind === "Coordination";
  const said = useRef({ failed, unread, coordination });
  useEffect(() => {
    const before = said.current;
    said.current = { failed, unread, coordination };
    if (coordination && !before.coordination)
      say({ fact: "another nexus tab has the player and isn’t answering." }, [{ label: "retry", commandKey: "retry player owner", run: commands.checkQueue }]);
    if (title === null) return;
    const retry: Verbs = [{ label: "retry", commandKey: "retry playback", run: commands.retry }];
    if (failed !== null && failed !== before.failed) say({ fact: `couldn’t play “${title}”.` }, retry);
    if (unread !== null && unread !== before.unread) say({ fact: `couldn’t load your place in “${title}”.` }, retry);
  }, [failed, unread, coordination, title, say, commands]);
  return <>
    {place?.kind === "Unsaved" && admitted && episode !== null && title !== null ? <Hold id={`place:${episode}`} attempt={place.attempt}
      line={{ fact: `couldn’t save your place in “${title}”.` }} verbs={[{ label: "retry", commandKey: "retry place", run: commands.retry }]} /> : null}
    {queue.unanswered > 0 ? <Hold id={`queue:${queue.header?.queue_id ?? "new"}`} attempt={queue.unanswered}
      {...androidShell ? { line: { fact: "not sure the queue saved.", reason: UNKNOWN_OUTCOME_REASON },
        verbs: [{ label: "retry", commandKey: "retry queue", run: commands.checkQueue, busy: queue.phase === "Saving" }] as const }
        : resendFeedback({ line: { fact: "not sure the queue saved.", reason: UNKNOWN_OUTCOME_REASON },
          resend: { label: "retry", commandKey: "retry queue", run: commands.checkQueue, busy: queue.phase === "Saving" } })} /> : null}
  </>;
}
