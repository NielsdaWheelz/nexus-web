"use client";

import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref, type SyntheticEvent, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { ServerValue } from "@/lib/api/serverState";
import { codepointLength, codepointToUtf16 } from "@/lib/canonicalText/codepoints";
import type { Timeline, Turn, TurnKey } from "@/lib/chat/wire";
import { publishPaneScroll } from "@/lib/panes/paneScroll";
import { requirePaneRuntime, usePaneRuntime, usePaneRouter } from "@/lib/panes/paneRuntime";
import { useSourceArrival, useArrivalFailure } from "@/lib/reader/sourceArrival";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import * as Icon from "@/lib/ui/icons";
import { focusableElements } from "@/lib/ui/overlay";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import ChatTurn from "./ChatTurn";
import { useLibrarianReferences } from "./LibrarianReferences";
import { useTranscriptBodies } from "./transcriptBodies";
import { useTranscriptWindow } from "./transcriptWindow";
import { inspectChatMessage, useChatScroll, type ChatReadingPosition, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

const EMPTY_ORDER: readonly TurnKey[] = [];

const READING_POSITION = definePaneVisitDataKey<{ queryKey: string; position: ChatReadingPosition | null }>("Librarian.ReadingPosition");

export interface LibrarianTranscriptHandle { onComposerWheel(event: WheelEvent<HTMLElement>): void }

/** React portals retain ancestry; only this scrollport's DOM can affect its reading place. */
function containsTarget(event: SyntheticEvent<HTMLElement>): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

/** The timeline's mounted scroll owner; search mounts a separate result surface. */
export default function LibrarianTranscript({ history, adopted, messageId, queryKey, retryBlocked, onRetry, ref }: {
  queryKey: string;
  messageId: string | null;
  history: ServerValue<Timeline>;
  adopted: readonly Turn[];
  retryBlocked: string | null;
  onRetry(runId: string): void;
  ref: Ref<LibrarianTranscriptHandle>;
}) {
  const { accountId } = useAuthenticatedAccount();
  const runtime = requirePaneRuntime(usePaneRuntime(), "librarian transcript");
  const scope = `${accountId}:${runtime.visitId}:${queryKey}`;
  const router = usePaneRouter();
  const timeZone = useHydratedBrowserTimeZone();
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const port = scrollport.current;
    if (port) return publishPaneScroll(port);
  }, []);
  const timeline = history.status === "ready" ? history.data : null;
  const order = useMemo(() => {
    const canonical = timeline?.order ?? EMPTY_ORDER;
    const accepted = new Set(canonical.map(key => key.run_id));
    const pending = adopted.flatMap(turn => accepted.has(turn.run_id) ? [] : [{
      run_id: turn.run_id, user_message_id: turn.user_message.id, assistant_message_id: turn.assistant_message.id,
      user_seq: turn.user_message.seq, created_at: turn.user_message.created_at,
    }]);
    return pending.length === 0 ? canonical
      : [...canonical, ...pending].sort((left, right) => BigInt(left.user_seq) < BigInt(right.user_seq) ? -1 : 1);
  }, [timeline, adopted]);
  const entry = useMemo(() => messageId === null ? null : order.find(key =>
    key.user_message_id === messageId || key.assistant_message_id === messageId)?.run_id ?? null, [messageId, order]);
  const scrollHandle = useRef<ChatScrollHandle | null>(null);
  const retainedPosition = usePaneVisitData(READING_POSITION, () => history.status === "ready"
    ? { queryKey, position: scrollHandle.current?.captureReadingPosition() ?? null } : null);
  const readingPosition = retainedPosition?.queryKey === queryKey ? retainedPosition.position : null;
  const saveReadingPosition = usePaneVisitDataWriter(READING_POSITION);
  const restoredPosition = useRef<ChatReadingPosition | null>(null);
  const restoreId = restoredPosition.current === readingPosition ? null : readingPosition?.point?.runId ?? null;
  const [passage, setPassage] = useState<{ messageId: string; start: number; end: number; activationId: string } | null>(null);
  const [keyboard, setKeyboard] = useState<{ id: string; reverse: boolean; origin: HTMLElement } | null>(null);
  const pinned = [
    ...(keyboard === null ? [] : [keyboard.id]),
    ...(entry === null ? [] : [entry]),
    ...(restoreId === null ? [] : [restoreId]),
    ...(timeline?.items ?? []).filter(turn => turn.assistant_message.status === "pending").map(turn => turn.run_id),
    ...adopted.map(turn => turn.run_id),
  ];
  const view = useTranscriptWindow(scrollport, transcript, order, restoreId ?? entry, pinned);
  const bodies = useTranscriptBodies(timeline, adopted, view.demand, history.revalidate);
  const last = view.shown.at(-1);
  const turns = view.rows.flatMap(row => {
    const body = bodies.get(row.key.run_id);
    return body ? [body] : [];
  });
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const scroll = useChatScroll(scrollport, transcript, last?.user_message_id ?? null, entry, messageId === null,
    adopted.at(-1)?.run_id ?? null, () => arrivalRef.current?.supersede({ preserveSignal: null, retireFailure: false }), view);
  scrollHandle.current = scroll.handle;
  useImperativeHandle(ref, () => ({ onComposerWheel: scroll.onComposerWheel }), [scroll.onComposerWheel]);
  const references = useLibrarianReferences({ scope, queryKey, turns, ready: history.status === "ready", port: scrollport, transcript, scroll: scroll.handle });
  const restoreReady = restoreId === null || bodies.get(restoreId) !== null || !order.some(key => key.run_id === restoreId) || bodies.unavailable(restoreId);
  useLayoutEffect(() => {
    if (history.status !== "ready" || readingPosition === null || restoredPosition.current === readingPosition || !restoreReady) return;
    restoredPosition.current = readingPosition;
    scroll.handle.restoreReadingPosition(readingPosition);
  }, [history.status, readingPosition, restoreReady, scroll.handle]);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const origin = event.target;
    const slot = origin instanceof HTMLElement ? origin.closest<HTMLElement>("[data-chat-run]") : null;
    if (!slot || !(origin instanceof HTMLElement)) return;
    const controls = focusableElements(slot);
    if ((event.shiftKey ? controls[0] : controls.at(-1)) !== origin) return;
    const rank = view.shown.findIndex(key => key.run_id === slot.dataset.chatRun);
    const next = view.shown[rank + (event.shiftKey ? -1 : 1)];
    if (!next) return;
    const neighbor = transcript.current?.querySelector<HTMLElement>(`[data-chat-run="${CSS.escape(next.run_id)}"]`);
    if (neighbor && focusableElements(neighbor).length > 0) return;
    event.preventDefault();
    setKeyboard({ id: next.run_id, reverse: event.shiftKey, origin });
  };
  const hasKeyboardBody = keyboard !== null && bodies.get(keyboard.id) !== null;
  useLayoutEffect(() => {
    if (!keyboard) return;
    if (document.activeElement !== keyboard.origin || !order.some(key => key.run_id === keyboard.id)) {
      setKeyboard(null);
      return;
    }
    const row = transcript.current?.querySelector<HTMLElement>(`[data-chat-run="${CSS.escape(keyboard.id)}"]`);
    const target = row ? focusableElements(row).at(keyboard.reverse ? -1 : 0) : null;
    if (!target) return;
    target.focus({ preventScroll: true });
    scroll.handle.revealControl(target);
    setKeyboard(null);
  }, [hasKeyboardBody, keyboard, order, scroll.handle]);
  const arrival = useSourceArrival({ ready: history.status === "ready" && restoreReady && timeZone !== null, sourceIdentity: accountId, apply: async (target, context) => {
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
  const formats = useMemo(() => timeZone === null ? null : {
    day: new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }),
    year: new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric" }),
    full: new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }),
    time: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  }, [timeZone]);
  const firstFailure = view.demand.find(id => bodies.error(id) !== null || bodies.unavailable(id));
  return <div ref={scrollport} className={styles.scrollport} role="region" tabIndex={0} aria-label="librarian conversation"
    onFocusCapture={event => { if (containsTarget(event)) references.interactions.onFocusCapture(event); }}
    onPointerDownCapture={event => { if (containsTarget(event)) references.interactions.onPointerDownCapture(); }}
    onMouseOver={event => { if (containsTarget(event)) references.interactions.onMouseOver(event); }}
    onMouseLeave={event => { if (containsTarget(event)) references.interactions.onMouseLeave(); }}
    onScroll={event => { if (containsTarget(event)) { scroll.onScroll(); saveReadingPosition({ queryKey, position: scroll.handle.captureReadingPosition() }); } }}
    onKeyDown={event => { if (containsTarget(event)) moveFocus(event); }}
    onFocus={event => { if (containsTarget(event)) scroll.onFocus(event); }}
    onPointerDown={event => { if (containsTarget(event)) scroll.onPointerDown(event); }}
    onClick={event => { if (containsTarget(event)) scroll.onClick(event); }}>
    {history.status === "loading" ? <Ruling /> : history.status === "failed" ? <Failed error={history.error} noun="messages" retry={{ run: history.refetch, busy: history.retrying }} /> : null}
    <div ref={transcript} className={styles.transcript} role="log" aria-label="librarian messages">
      {history.status === "ready" && order.length === 0 ? <div className={styles.absent}><p className={styles.empty}>read, think, and make connections with your librarian.</p></div> : null}
      {view.rows.map(({ rank, key, height, gap }) => {
        const turn = bodies.get(key.run_id);
        const measured = turn !== null && formats !== null;
        const date = new Date(key.created_at);
        const previous = rank === 0 ? null : new Date(view.shown[rank - 1].created_at);
        const error = key.run_id === firstFailure ? bodies.error(key.run_id) : null;
        const label = formats?.day.format(date).toLowerCase() ?? "";
        const year = formats?.year.format(date);
        const newYear = previous === null || formats?.year.format(previous) !== year;
        const newDay = newYear || (formats !== null && previous !== null && label !== formats.day.format(previous).toLowerCase());
        return <div key={key.run_id} style={{ marginBlockStart: gap }}>
          <div ref={view.observe} className={styles.turnSlot} data-chat-run={key.run_id}
            data-after-first={rank !== 0 || undefined} data-chat-measured={measured || undefined}
            style={measured && view.motion === "still" ? undefined : { height, overflow: "clip" }}>
            {turn && formats
              ? <ChatTurn turn={turn} passage={passage}
                  day={newDay ? { label: newYear ? `${label} ${year}` : label, full: formats.full.format(date) } : null}
                  time={formats.time.format(date)} refresh={history.revalidate} onInspect={scroll.handle.inspectDisclosure}
                  onRetry={() => onRetry(turn.run_id)} retryBlocked={retryBlocked} inlineAttachments={references.inlineAttachments}
                  onReadTurn={bodies.adopt} onContentLayout={scroll.afterLayout} onRevealReferences={references.reveal} />
              : error ? <Failed error={error} noun="messages" retry={{ run: bodies.retry, busy: false }} />
              : key.run_id === firstFailure && bodies.unavailable(key.run_id) ? <Fact line={{ fact: "this turn is unavailable." }} /> : null}
          </div>
        </div>;
      })}
      <div className={styles.spacer} aria-hidden="true" style={{ height: scroll.spacer }} />
    </div>
    {scroll.latestBelow || messageId ? <div className={styles.latest}><Button icon={<Icon.Down />} onClick={() => messageId ? router.push("/librarian") : scroll.toLatest()}>latest</Button></div> : null}
  </div>;
}
