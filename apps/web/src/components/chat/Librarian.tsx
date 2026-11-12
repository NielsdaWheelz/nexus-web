"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { StageAnchor } from "@/components/feedback/Slips";
import Button from "@/components/ui/Button";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { readCatalog } from "@/lib/chat/catalog";
import { commandKey, getLibrarianCommands, IDLE_COMMAND, sayRefusal, unsureFact } from "@/lib/chat/commands";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { unavailability } from "@/lib/chat/selection";
import { createRandomId } from "@/lib/createRandomId";
import { useChatDraft, type Draft } from "@/lib/chat/drafts";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneIsActive, usePaneRuntime, usePaneSearchParams, usePaneRouter } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey, type PaneVisitDataKey, usePaneReturnReady, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import type { Visit } from "@/lib/api/serverState";
import type { Catalog, Timeline } from "@/lib/chat/wire";
import * as Icon from "@/lib/ui/icons";
import ChatOperationBoundary from "./ChatOperationBoundary";
import ChatComposer from "./ChatComposer";
import ChatTurn from "./ChatTurn";
import { useSourceArrival, useArrivalFailure } from "@/lib/reader/sourceArrival";
import { inspectChatMessage, useChatScroll, type ChatReadingPosition } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Librarian.Catalog");
const READING_POSITION = definePaneVisitDataKey<ChatReadingPosition>("Librarian.ReadingPosition");
const TIMELINE_VISIT: PaneVisitDataKey<Visit<Timeline>> = definePaneVisitDataKey("Librarian.Timeline");

/** A bounded window onto the account's sole append-only timeline. The composer
 * has no reply endpoint: viewing old messages cannot change where a send lands. */
export default function Librarian() {
  const { accountId } = useAuthenticatedAccount();
  const runtime = requirePaneRuntime(usePaneRuntime(), "Librarian");
  const active = usePaneIsActive();
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const changes = useChangeStamp("Chats", "Metadata", "Notes", "NoteBodies");
  const foreground = useRefreshStamp(active, 0);
  const commandOwner = useMemo(() => getLibrarianCommands(accountId), [accountId]);
  const command = useSyncExternalStore(commandOwner.subscribe, commandOwner.getSnapshot, () => IDLE_COMMAND);
  const defect = useSyncExternalStore(commandOwner.subscribe, commandOwner.getDefect, () => null);
  const draft = useChatDraft(runtime.paneId);
  const memory = useChatSelection();
  const catalog = useServerValue({ key: "/llm-catalog", stale: String(foreground), visit: CATALOG_VISIT, load: readCatalog });
  const currentCatalog = catalog.status === "ready" ? catalog.data : null;
  const selection = draft.draft.selection.kind === "Uninitialized" ? memory.fresh(currentCatalog) ?? draft.draft.selection : draft.draft.selection;
  const modelReason = currentCatalog && selection.kind !== "Uninitialized" ? unavailability(currentCatalog, selection) : null;
  const retryAvailable = command.kind === "Idle" && currentCatalog !== null && selection.kind === "Selected" && modelReason === null;
  const messageId = params.get("message");
  const before = params.get("before_seq");
  const after = params.get("after_seq");
  const query = new URLSearchParams({ limit: "25" });
  if (messageId !== null) query.set("around_message_id", messageId);
  else if (before !== null) query.set("before_seq", before);
  else if (after !== null) query.set("after_seq", after);
  const path = `/api/librarian/messages?${query}` as const;
  const history = useServerValue<Timeline>({ key: path, stale: `${changes}:${foreground}`, visit: TIMELINE_VISIT,
    load: async signal => (await apiFetch<ApiJson<"/librarian/messages", "get">>(path, { signal })).data });
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const timeline = history.status === "ready" ? history.data : null;
  const turns = timeline?.items ?? [];
  const last = turns.at(-1);
  const scroll = useChatScroll(scrollport, transcript, last?.user_message.id ?? null, last?.assistant_message.id ?? null, history.status === "ready");
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
    const ref = target.source.source_activation?.resource_ref;
    if (!ref?.startsWith("message:")) return "Unavailable";
    const id = ref.slice("message:".length);
    const message = turns.flatMap(turn => [turn.user_message, turn.assistant_message]).find(message => message.id === id);
    if (!message) return "Unavailable";
    const offsets = location.kind === "live" && location.locator.kind === "TextOffsets" ? location.locator
      : location.kind === "located" && location.locator.type === "message_offsets" && location.locator.message_id === id ? location.locator : null;
    if (location.kind !== "resource" && offsets === null) return "Unavailable";
    if (offsets && (offsets.start_offset < 0 || offsets.end_offset <= offsets.start_offset || offsets.end_offset > Array.from(message.content).length)) return "Unavailable";
    setPassage(offsets ? { messageId: id, start: offsets.start_offset, end: offsets.end_offset, activationId: context.activationId } : null);
    context.signal.addEventListener("abort", () => setPassage(current => current?.activationId === context.activationId ? null : current), { once: true });
    return await inspectChatMessage(scroll.handle, id, context) ? "Applied" : "Unavailable";
  } });
  useArrivalFailure(arrival.failure);
  usePaneReturnReady(history.status !== "loading");
  const [autoSend, setAutoSend] = useState<{ id: string; draft: Draft } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const { delivery, claim } = usePaneEntryDelivery();
  useLayoutEffect(() => {
    if (!delivery || (delivery.entry.kind !== "FocusLibrarian" && delivery.entry.kind !== "ComposeChat")) return;
    if (!claim(delivery)) return;
    const entry = delivery.entry;
    if (entry.kind === "ComposeChat") draft.seed(entry.text);
    if (entry.kind === "ComposeChat" || entry.send) setAutoSend({ id: delivery.activationId, draft: draft.entry.getSnapshot().draft });
    setFocus(delivery.activationId);
  }, [delivery, claim, draft]);
  useLayoutEffect(() => {
    if (history.status !== "ready" || !messageId || readingPosition !== null) return;
    scroll.handle.inspectMessage(messageId, true);
  }, [history.status, timeline, messageId, readingPosition, scroll.handle]);
  const accepted = draft.accepted;
  useEffect(() => {
    if (!accepted) return;
    if (messageId || before || after) router.replace("/librarian");
    else history.revalidate();
    draft.accountFor(accepted);
  }, [accepted, messageId, before, after, router, history, draft]);
  const slips = useOutcome();
  const resend = useResendFeedback();
  const retryTurn = (runId: string) => {
    if (!retryAvailable || selection.kind !== "Selected") return;
    void commandOwner.execute({ kind: "RetryTurn", sourceRunId: runId, runId: createRandomId(), selection: selection.selection, viewId: runtime.paneId })
      .then(outcome => { sayRefusal(slips, outcome); if (outcome.kind === "Accepted" && (messageId || before || after)) router.replace("/librarian"); })
      .catch(error => commandOwner.reportDefect(error));
  };
  const retryCommand = useCallback(() => void commandOwner.retry().then(outcome => sayRefusal(slips, outcome)), [commandOwner, slips]);
  const recovery = command.kind !== "Idle" && command.standing?.kind === "Unknown"
    ? resend({ line: { fact: unsureFact(command.command), reason: "retry sends the same request." }, resend: { label: "retry", commandKey: commandKey(command.command), busy: command.kind === "Busy", run: retryCommand } }) : null;
  usePaneChrome({ refresh: { kind: "Refreshable", sourceKey: "librarian", execute: async () => { await history.refetch(); return null; } } });
  const hold = recovery && command.kind !== "Idle" ? <Hold id={commandKey(command.command)} attempt={command.attempt} {...recovery} /> : null;
  const commandFeedback = defect ? <ChatOperationBoundary failure={defect} paneId={runtime.paneId} visitId={runtime.visitId}
    fallback={hold ?? <Fact line={{ fact: "this librarian action stopped unexpectedly." }} verbs={[{ label: "dismiss", commandKey: "dismiss librarian defect", run: commandOwner.clearDefect }]} />} /> : hold;
  return <div className={styles.surface}>
      <div ref={scrollport} className={styles.scrollport} role="region" tabIndex={0} aria-label="librarian conversation"
        onScroll={() => { scroll.onScroll(); saveReadingPosition(scroll.handle.captureReadingPosition()); }} onFocus={scroll.onFocus} onWheel={scroll.onUserScroll} onTouchMove={scroll.onUserScroll}
        onKeyDown={scroll.onKeyDown} onPointerDown={scroll.onPointerDown} onClick={scroll.onClick}>
        {history.status === "loading" ? <Ruling /> : history.status === "failed" ? <Failed error={history.error} noun="messages" retry={{ run: history.refetch, busy: history.retrying }} /> : null}
        <div ref={transcript} className={styles.transcript} role="log" aria-label="librarian messages">
          {history.status === "ready" && history.data.before_seq ? <Button onClick={() => router.replace(`/librarian?before_seq=${history.data.before_seq}`)}>earlier messages</Button> : null}
          {history.status === "ready" && turns.length === 0 ? <div className={styles.absent}><p>read, think, and make connections with your librarian.</p></div> : null}
          {turns.map((turn, ordinal) => <ChatTurn key={turn.run_id} turn={turn} passage={passage} ordinal={ordinal * 2 + 1} refresh={history.revalidate} onInspect={scroll.handle.inspectDisclosure} onRetry={() => retryTurn(turn.run_id)} retryAvailable={retryAvailable} />)}
          {history.status === "ready" && history.data.after_seq ? <Button onClick={() => router.replace(`/librarian?after_seq=${history.data.after_seq}`)}>later messages</Button> : null}
          <div className={styles.spacer} aria-hidden="true" style={{ height: scroll.spacer }} />
        </div>
        {scroll.latestBelow || messageId || before || after ? <div className={styles.latest}><Button icon={<Icon.Down />} onClick={() => messageId || before || after ? router.replace("/librarian") : scroll.toLatest()}>latest</Button></div> : null}
      </div>
      <div className={styles.composerAnchor}><StageAnchor kind="Pane" paneId={runtime.paneId} /></div>
      <div className={styles.composerSlot} data-has-messages={turns.length > 0 || undefined} onWheel={scroll.onComposerWheel}>
        {commandFeedback}
        {history.status === "ready" && history.error ? <Fact line={{ fact: "messages stopped updating." }} verbs={[{ label: "retry", commandKey: "refresh librarian", run: history.refetch }]} /> : null}
        <div className={styles.lanes}><Link href="/settings/account">edit reading brief</Link></div>
        <ChatComposer selection={selection} reason={modelReason} autoSend={autoSend} catalog={catalog} command={command} owner={commandOwner} focusKey={focus} />
      </div>
    </div>;
}
