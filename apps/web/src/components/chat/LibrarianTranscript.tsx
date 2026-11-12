"use client";

import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { ServerValue } from "@/lib/api/serverState";
import { codepointLength, codepointToUtf16 } from "@/lib/canonicalText/codepoints";
import type { Timeline } from "@/lib/chat/wire";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { useSourceArrival, useArrivalFailure } from "@/lib/reader/sourceArrival";
import * as Icon from "@/lib/ui/icons";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import ChatTurn from "./ChatTurn";
import { inspectChatMessage, useChatScroll, type ChatReadingPosition } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

const READING_POSITION = definePaneVisitDataKey<ChatReadingPosition>("Librarian.ReadingPosition");

export interface LibrarianTranscriptHandle { onComposerWheel(event: WheelEvent<HTMLElement>): void }

/** The timeline's mounted scroll owner; search mounts a separate result surface. */
export default function LibrarianTranscript({ history, retryAvailable, onRetry, ref }: {
  history: ServerValue<Timeline>;
  retryAvailable: boolean;
  onRetry(runId: string): void;
  ref: Ref<LibrarianTranscriptHandle>;
}) {
  const { accountId } = useAuthenticatedAccount();
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const messageId = params.get("message");
  const before = params.get("before_seq");
  const after = params.get("after_seq");
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const turns = history.status === "ready" ? history.data.items : [];
  const last = turns.at(-1);
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const scroll = useChatScroll(scrollport, transcript, last?.user_message.id ?? null, last?.assistant_message.id ?? null, history.status === "ready",
    () => arrivalRef.current?.supersede({ preserveSignal: null, retireFailure: false }));
  useImperativeHandle(ref, () => ({ onComposerWheel: scroll.onComposerWheel }), [scroll.onComposerWheel]);
  const readingPosition = usePaneVisitData(READING_POSITION, () => history.status === "ready" ? scroll.handle.captureReadingPosition() : null);
  const saveReadingPosition = usePaneVisitDataWriter(READING_POSITION);
  const restoredPosition = useRef<ChatReadingPosition | null>(null);
  useLayoutEffect(() => {
    if (history.status !== "ready" || readingPosition === null || restoredPosition.current === readingPosition) return;
    restoredPosition.current = readingPosition;
    scroll.handle.restoreReadingPosition(readingPosition);
  }, [history.status, readingPosition, scroll.handle]);
  const [passage, setPassage] = useState<{ messageId: string; start: number; end: number; activationId: string } | null>(null);
  const arrival = useSourceArrival({ ready: history.status === "ready", sourceIdentity: accountId, apply: async (target, context) => {
    if (target.kind !== "source") return "Unavailable";
    const location = target.source.location;
    const resource = target.source.source_activation?.resource_ref;
    if (!resource?.startsWith("message:")) return "Unavailable";
    const id = resource.slice("message:".length);
    const message = turns.flatMap(turn => [turn.user_message, turn.assistant_message]).find(message => message.id === id);
    if (!message) return "Unavailable";
    const offsets = location.kind === "live" && location.locator.kind === "TextOffsets" ? location.locator
      : location.kind === "located" && location.locator.type === "message_offsets" && location.locator.message_id === id ? location.locator : null;
    if (location.kind !== "resource" && offsets === null) return "Unavailable";
    if (offsets && (offsets.start_offset < 0 || offsets.end_offset <= offsets.start_offset || offsets.end_offset > codepointLength(message.content))) return "Unavailable";
    const selected = offsets ? { start: codepointToUtf16(message.content, offsets.start_offset), end: codepointToUtf16(message.content, offsets.end_offset) } : null;
    // Message arrival follows awaited source-target resolution, outside React's
    // commit. Commit its paint before the scroll owner measures that passage.
    flushSync(() => setPassage(selected ? { messageId: id, ...selected, activationId: context.activationId } : null));
    context.signal.addEventListener("abort", () => setPassage(current => current?.activationId === context.activationId ? null : current), { once: true });
    const restore = context.restored || context.purpose === "RestoreVisit" && readingPosition !== null;
    return await inspectChatMessage(scroll.handle, id, { ...context, restored: restore }, selected) ? "Applied" : "Unavailable";
  } });
  arrivalRef.current = arrival;
  useArrivalFailure(arrival.failure);
  return <div ref={scrollport} className={styles.scrollport} role="region" tabIndex={0} aria-label="librarian conversation"
    onScroll={() => { scroll.onScroll(); saveReadingPosition(scroll.handle.captureReadingPosition()); }} onFocus={scroll.onFocus}
    onWheel={scroll.onUserScroll} onTouchMove={scroll.onUserScroll} onKeyDown={scroll.onKeyDown} onPointerDown={scroll.onPointerDown} onClick={scroll.onClick}>
    {history.status === "loading" ? <Ruling /> : history.status === "failed" ? <Failed error={history.error} noun="messages" retry={{ run: history.refetch, busy: history.retrying }} /> : null}
    <div ref={transcript} className={styles.transcript} role="log" aria-label="librarian messages">
      {history.status === "ready" && history.data.before_seq ? <Button onClick={() => router.replace(`/librarian?before_seq=${history.data.before_seq}`)}>earlier messages</Button> : null}
      {history.status === "ready" && turns.length === 0 ? <div className={styles.absent}><p>read, think, and make connections with your librarian.</p></div> : null}
      {turns.map(turn => <ChatTurn key={turn.run_id} turn={turn} passage={passage} refresh={history.revalidate} onInspect={scroll.handle.inspectDisclosure} onRetry={() => onRetry(turn.run_id)} retryAvailable={retryAvailable} />)}
      {history.status === "ready" && history.data.after_seq ? <Button onClick={() => router.replace(`/librarian?after_seq=${history.data.after_seq}`)}>later messages</Button> : null}
      <div className={styles.spacer} aria-hidden="true" style={{ height: scroll.spacer }} />
    </div>
    {scroll.latestBelow || messageId || before || after ? <div className={styles.latest}><Button icon={<Icon.Down />} onClick={() => messageId || before || after ? router.push("/librarian") : scroll.toLatest()}>latest</Button></div> : null}
  </div>;
}
