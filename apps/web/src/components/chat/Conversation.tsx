"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useFailedReadRepair, useServerValue, type Visit } from "@/lib/api/serverState";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogChat } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { readCatalog } from "@/lib/chat/catalog";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { useChatDraft } from "@/lib/chat/drafts";
import { changedLine, commandKey, MAY_HAVE, PENDING_CHANGE, sayRefusal, unsureFact, type CommandOutcome } from "@/lib/chat/commands";
import { parseReaderSelectionHash } from "@/lib/chat/readerIntent";
import { chatView, indexChildren, leafUnder, pathTo, type BranchDraft } from "@/lib/chat/tree";
import { conversationEndpoint, conversationViewHref, type ConversationEndpoint } from "@/lib/chat/view";
import type { Catalog } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import { useFind } from "@/lib/find/useFind";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { openAsyncResult } from "@/lib/panes/openResult";
import {
  paneSourceKey,
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneHash,
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  type PaneRuntimeContextValue,
} from "@/lib/panes/paneRuntime";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { CommandVerb, Verbs } from "@/components/feedback/stage";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey, usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import ChatComposer from "./ChatComposer";
import ChatSurface from "./ChatSurface";
import ChatContext from "./ChatContext";
import { inspectConversationFindMatch, useConversationFindSource } from "./conversationFind";
import { useChatStore, type ChatStore } from "./conversationStore";
import { ForksPanel } from "./Forks";
import { useQuotePreview } from "./QuotedPassage";
import { inspectChatMessage, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

const CATALOG_VISIT = definePaneVisitDataKey<Visit<Catalog>>("Chat.Catalog");

/** The conversation pane. A changed route id mounts a fresh conversation. */
export default function ConversationPane() {
  const id = usePaneParam("id");
  return <Conversation key={id ?? "new"} conversationId={id} />;
}

/** Keep `messageId` as this visit's endpoint and the rest of its href; false once the visit moved on. */
function persistEndpoint(runtime: Pick<PaneRuntimeContextValue, "href" | "visitId" | "updatePaneViewHref">, messageId: string | null) {
  const href = new URL(runtime.href, "https://nexus.invalid");
  href.searchParams.set("leaf", messageId ?? "empty");
  return runtime.updatePaneViewHref({ visitId: runtime.visitId, href: `${href.pathname}${href.search}${href.hash}`, arrival: "preserve" });
}

// Route state (id, ?leaf, ?message, the quote hash), the pane's endpoint and
// the fork being composed live here; the store owns server state, the command owner
// owns writes, the pane lands their answers.
function Conversation({ conversationId }: { conversationId: string | null }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "Conversation");
  const [state, store] = useChatStore(conversationId, runtime.paneId);
  const savedCatalog = useCatalogState();
  const saved = conversationId === null || savedCatalog.data === null ? null : catalogChat(savedCatalog.data, conversationId);
  const catalogRead = useServerValue({
    key: "/llm-catalog",
    stale: "",
    visit: CATALOG_VISIT,
    load: readCatalog,
  });
  const latestRuntime = useRef(runtime);
  latestRuntime.current = runtime;
  const { ctx } = useActionRuntime();
  const router = usePaneRouter();
  const isPaneActive = usePaneIsActive();
  const params = usePaneSearchParams();
  const hash = usePaneHash();
  const intent = useMemo(() => sourceTargetFromHref(runtime.href) ? { kind: "none" as const } : parseReaderSelectionHash(hash), [hash, runtime.href]);
  const { quote, retry: retryQuote } = useQuotePreview(
    intent.kind === "key" ? intent.key : null,
  );
  const [branch, setBranch] = useState<BranchDraft | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [invalidatedInspection, setInvalidatedInspection] = useState(false);
  const scroll = useRef<ChatScrollHandle | null>(null);
  const { messages, activeSendLeafId, history, contextVersion } = state;
  const ready = history === "Ready";
  // The pane's endpoint: the last message of the path it shows, this pane's alone. An
  // explicit ?leaf= wins; a bare route keeps the visit's, else seeds once from the last send.
  const requested = useMemo(() => conversationEndpoint(params), [params]);
  const [endpoint, setEndpoint] = useState<{ visitId: string; value: ConversationEndpoint }>(
    () => ({ visitId: runtime.visitId, value: requested }),
  );
  const selected = requested.kind === "Unspecified" ? endpoint.value : requested;
  const leafId = selected.kind === "Endpoint" ? selected.messageId
    : selected.kind === "Unspecified" ? activeSendLeafId : null;
  const latestLeaf = useRef(leafId);
  latestLeaf.current = leafId;
  const unavailableBranch = selected.kind === "Invalid" || (ready && leafId !== null && !messages.has(leafId));
  const view = useMemo(
    () => chatView({ messages, leafId, history: unavailableBranch ? "Unavailable" : history }, conversationId, branch),
    [messages, leafId, history, unavailableBranch, conversationId, branch],
  );
  const previousMessages = useRef(messages);
  const clearFind = useRef<(() => void) | null>(null);

  const fork = useCallback((draft: BranchDraft) => {
    const command = store.getState().command;
    if (command.kind !== "Idle" && command.command.kind === "Send") return;
    setBranch(draft);
    setFocusKey(`${draft.parentId}:${Date.now()}`);
  }, [store]);

  const arrival = useSourceArrival({
    ready,
    sourceIdentity: conversationId,
    onAttempt: (_signal, target) => { if (target.kind === "chat_destination") clearFind.current?.(); },
    apply: async (arrivalTarget, context) => {
      if (arrivalTarget.kind === "chat_destination") {
        setInvalidatedInspection(false);
        const { destination, leaf_id } = arrivalTarget;
        const message = store.getState().messages.get(destination.message_id);
        if (!message || message.status === "pending" || context.signal.aborted) return "Unavailable";
        const stillCurrent = () => {
          const current = store.getState().messages.get(message.id);
          const endpoint = conversationEndpoint(new URL(latestRuntime.current.href, "https://nexus.invalid").searchParams);
          return current?.content === message.content && current.status === message.status &&
            endpoint.kind === "Endpoint" && endpoint.messageId === leaf_id && latestLeaf.current === leaf_id &&
            pathTo(store.getState().messages, leaf_id).some((item) => item.id === message.id);
        };
        if (!stillCurrent()) return "Unavailable";
        const inspection = new AbortController();
        const retire = () => inspection.abort();
        const unsubscribe = store.subscribe(() => {
          if (!stillCurrent()) { setInvalidatedInspection(true); retire(); }
        });
        context.signal.addEventListener("abort", retire, { once: true });
        inspection.signal.addEventListener("abort", () => {
          unsubscribe();
          context.signal.removeEventListener("abort", retire);
        }, { once: true });
        try {
          const outcome = await inspectConversationFindMatch({ handle: scroll.current, destination, context: { ...context, signal: inspection.signal }, isCurrent: stillCurrent });
          if (outcome !== "Applied") retire();
          return outcome;
        } catch (error) {
          retire();
          throw error;
        }
      }
      if (arrivalTarget.kind !== "source") return "Unavailable";
      const result = arrivalTarget.source;
      setInvalidatedInspection(false);
      if (result.location.kind === "resource") {
        if (context.mayFocus()) {
          const transcript = scroll.current?.getTranscriptElement();
          if (transcript) { transcript.tabIndex = -1; transcript.focus({ preventScroll: true }); }
        }
        return "Applied";
      }
      if (result.location.kind !== "located" || result.location.locator.type !== "message_offsets") return "Unavailable";
      const locator = result.location.locator;
      const message = store.getState().messages.get(locator.message_id);
      if (!message || locator.conversation_id !== conversationId || context.signal.aborted) return "Unavailable";
      if (locator.start_offset !== 0 || locator.end_offset !== Array.from(message.content).length) return "Unavailable";
      const exact = message.content;
      if (locator.text_quote_selector?.exact !== exact) return "Unavailable";
      const inspection = new AbortController();
      const retire = () => inspection.abort();
      const stillCurrent = () => store.getState().messages.get(message.id)?.content === exact;
      const unsubscribe = store.subscribe(() => {
        if (!stillCurrent()) {
          setInvalidatedInspection(true);
          retire();
        }
      });
      context.signal.addEventListener("abort", retire, { once: true });
      inspection.signal.addEventListener("abort", () => {
        unsubscribe();
        context.signal.removeEventListener("abort", retire);
      }, { once: true });
      try {
        // off the shown path: an explicit endpoint stands; a bare one moves to the newest branch under it
        const current = latestRuntime.current;
        let destination = latestLeaf.current;
        if (!pathTo(store.getState().messages, destination).some((item) => item.id === message.id)) {
          if (conversationEndpoint(new URL(current.href, "https://nexus.invalid").searchParams).kind !== "Unspecified") return "Unavailable";
          destination = leafUnder(indexChildren(store.getState().messages.values()), message.id);
        }
        if (context.signal.aborted || !persistEndpoint(current, destination)) return "Unavailable";
        setEndpoint({ visitId: current.visitId, value: { kind: "Endpoint", messageId: destination } });
        if (!stillCurrent() || context.signal.aborted) retire();
        const applied = !inspection.signal.aborted && await inspectChatMessage(scroll.current, message.id, { ...context, signal: inspection.signal });
        if (!applied) retire();
        return applied ? "Applied" : "Unavailable";
      } catch (error) {
        retire();
        throw error;
      }
    },
  });

  const clearSourceArrival = arrival.clear;
  const clearArrival = useCallback(() => {
    clearSourceArrival();
    setInvalidatedInspection(false);
  }, [clearSourceArrival]);
  /** Show `messageId`'s path in this pane: no write, only the pane's visit href. */
  const selectEndpoint = useCallback((messageId: string | null) => {
    if (!conversationId) return "unchanged" as const;
    if (!runtime.updatePaneViewHref({ visitId: runtime.visitId, href: conversationViewHref(conversationId, messageId), arrival: "clear" })) return "cancelled" as const;
    clearArrival();
    setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId } });
    setBranch(null);
    return "committed" as const;
  }, [conversationId, runtime, clearArrival]);
  // Sends, repeats and their retries go through the pane, which lands an accepted answer:
  // in this pane while it still shows the path asked from (a new chat's pane routes to
  // the chat), in a new pane on shift, else as an offer to open it. Rows, dialogs and the
  // composer share this store.
  const paneStore = useMemo((): ChatStore => {
    const land = async (run: () => Promise<CommandOutcome>, openIntent: OpenIntent, sending: string | null) => {
      const originLeaf = latestLeaf.current;
      let outcome: CommandOutcome = { kind: "Handled" };
      await openAsyncResult({
        ctx,
        originPaneId: runtime.paneId,
        intent: openIntent,
        subject: store.getState().conversation?.title ?? sending ?? undefined,
        mayOpen: () => latestLeaf.current === originLeaf,
        create: async () => {
          outcome = await run();
          if (outcome.kind !== "Accepted") return null;
          const { conversation_id, assistant_message_id } = outcome.receipt.outcome;
          return {
            target: { href: conversationViewHref(conversation_id, assistant_message_id) },
            // admitted, its answer still pending
            title: sending === null ? "new answer started" : "message sent",
            openLabel: "open answer",
          };
        },
        onDefault: (result) => {
          if (conversationId === null) return router.replace(result.target.href, { activate: false });
          const next = conversationEndpoint(new URL(result.target.href, "https://nexus.invalid").searchParams);
          if (next.kind === "Endpoint") return selectEndpoint(next.messageId);
        },
      });
      return outcome;
    };
    return {
      ...store,
      send: (request, selectionRoute, openIntent, onAcceptance) =>
        land(() => store.send(request, selectionRoute, openIntent, onAcceptance), openIntent, truncateText(request.content, 220)),
      repeat: (operation, assistantId, explicit, openIntent) =>
        land(() => store.repeat(operation, assistantId, explicit, openIntent), openIntent, null),
      // a retry may move a frozen landing to a new pane, never back
      retryCommand: (openIntent = "default") => {
        const pending = store.getState().command;
        const command = pending.kind === "Idle" ? null : pending.command;
        const frozen = command?.kind === "Send" || command?.kind === "Repeat" ? command.openIntent : "default";
        return land(() => store.retryCommand(openIntent), frozen === "new_pane" ? frozen : openIntent,
          command?.kind === "Send" ? truncateText(command.request.content, 220) : null);
      },
    };
  }, [store, ctx, runtime.paneId, conversationId, router, selectEndpoint]);

  // Message edits are delivered to a mounted pane once their target is on its path.
  const { delivery, claim } = usePaneEntryDelivery();
  const { enter: enterMemory } = useChatSelection();
  const { seed, draft } = useChatDraft(conversationId ?? "new", runtime.paneId);
  useLayoutEffect(() => {
    if (delivery?.entry.kind !== "ComposeChat") return;
    enterMemory();
    seed(delivery.entry.text);
    claim(delivery);
  }, [delivery, claim, seed, enterMemory]);
  const slips = useOutcome();
  const { say } = slips;
  const workspace = useLatestWorkspace();
  useEffect(() => {
    if (delivery === null || !("messageId" in delivery.entry) || !ready) return;
    const { entry } = delivery;
    const message = messages.get(entry.messageId);
    if (message && !view.path.some((m) => m.id === message.id)) {
      const leaf = leafUnder(indexChildren(messages.values()), message.id);
      clearArrival();
      if (persistEndpoint(runtime, leaf)) setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId: leaf } });
      return;
    }
    if (!claim(delivery)) return;
    if (!message) return void say({ fact: "couldn’t find that message." });
    if (entry.kind === "DeleteMessage") {
      // a refusal's retry deletes again, through the same confirmation
      const remove = () => void store.deleteMessage(message.id)
        .then((outcome) => sayRefusal(slips, outcome, { label: "retry", commandKey: `delete ${message.id}`, run: remove }));
      remove();
    } else if (message.role !== "assistant") {
      return;
    } else if (entry.kind === "ForkMessage") {
      fork({
        parentId: message.id,
        anchor: { kind: "assistant_message", message_id: message.id },
        quote: "",
      });
    }
  }, [fork, clearArrival, claim, delivery, say, slips, messages, ready, runtime, store, view.path]);
  useEffect(() => {
    if (!state.gone || conversationId === null) return;
    settleDeletedResourcePanes({
      workspace: workspace(),
      deletedRef: `conversation:${conversationId}`,
      fallbackHref: "/conversations",
    });
  }, [state.gone, conversationId, workspace]);
  const ownerKey = paneSourceKey(runtime);
  const findSource = useConversationFindSource({
    ownerKey,
    conversationId,
    activeLeafMessageId: leafId,
    messages: view.path,
    scroll,
    isCurrent: (message) => {
      const current = store.getState().messages.get(message.id);
      return latestLeaf.current === leafId && current?.content === message.content && current.status === message.status &&
        pathTo(store.getState().messages, leafId).some((item) => item.id === message.id);
    },
    onInspect: clearArrival,
  });
  const find = useFind({ ownerKey, source: findSource, onSearchIntent: clearArrival });
  clearFind.current = find?.clear ?? null;

  const bodies = useMemo(
    () => ({
      linkedItems: conversationId ? (
        <ChatContext conversationId={conversationId} refreshKey={contextVersion} />
      ) : (
        <Fact line={{ fact: "context opens after the first message." }} />
      ),
      forks: (
        <ForksPanel
          tree={view.children}
          pathIds={view.pathIds}
          onRename={store.renameFork}
          onDelete={store.deleteMessage}
        />
      ),
    }),
    [conversationId, contextVersion, view.children, view.pathIds, store],
  );
  useResourceInspector({
    scheme: "conversation",
    handle: state.conversation !== null && !state.gone ? conversationId : null,
    bodies,
  });
  // streaming re-renders this body often; publish only what changed.
  const savedOnly = conversationId !== null && !state.gone && history !== "Ready" && messages.size === 0 && draft.text === "" && branch === null && state.command.kind === "Idle" && !remoteReady() && !savedCatalog.loading;
  const loading = history === "Loading";
  usePaneChrome(
    useMemo(
      () => ({
        displayTitle: savedOnly && saved !== null ? saved.title || "untitled chat" : undefined,
        query: !conversationId
          ? undefined
          : loading
            ? { kind: "Find" as const, find: null }
            : ready && find
              ? { kind: "Find" as const, find }
              : undefined,
        resourceRef:
          conversationId && ready
            ? canonicalResourceRef({
                scheme: "conversation",
                id: conversationId,
              })
            : undefined,
      }),
      [savedOnly, saved, conversationId, find, loading, ready],
    ),
  );

  useLayoutEffect(() => {
    const value = requested.kind === "Unspecified" ? endpoint.value : requested;
    if (endpoint.visitId !== runtime.visitId || requested.kind !== "Unspecified") setEndpoint({ visitId: runtime.visitId, value });
    if (!ready || !conversationId || requested.kind !== "Unspecified" || value.kind === "Invalid" || params.has("message")) return;
    const messageId = value.kind === "Endpoint" ? value.messageId : activeSendLeafId;
    if (persistEndpoint(runtime, messageId)) setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: an explicit route or the first ready tree initializes the endpoint, once per visit
  }, [runtime.visitId, requested, ready]);
  useEffect(() => {
    if (!ready) return;
    const previous = previousMessages.current;
    previousMessages.current = messages;
    if (!conversationId || leafId === null || messages.has(leafId) || !previous.has(leafId) || params.has("loc")) return;
    // the shown branch was deleted: fall back to its nearest surviving ancestor, never another branch
    let ancestor = previous.get(leafId)?.parent_message_id ?? null;
    while (ancestor !== null && !messages.has(ancestor)) ancestor = previous.get(ancestor)?.parent_message_id ?? null;
    if (ancestor !== null) selectEndpoint(ancestor);
    say({ fact: "this branch was deleted." });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: a replaced graph repairs a known deleted endpoint once
  }, [messages, ready]);

  const pathOnly = conversationId ? conversationViewHref(conversationId, leafId) : "/conversations/new";
  // a source arrival's failure is said once, and retracted when it clears
  const arrivalFailure = arrival.failure?.title ?? (invalidatedInspection ? "the matched text changed." : null);
  useEffect(() => arrivalFailure === null ? undefined : say({ fact: arrivalFailure }), [arrivalFailure, say]);

  // Every pane that shows the chat shows a pending command's lane, but the pane whose composer sent
  // it: that composer holds it beside its draft. One pane holds it as a slip, the command owner's
  // `holder`, so two panes on one chat hold it once; while none shows the chat, the workspace holds
  // what a menu or the reader raised (lib/chat/commandFeedback.tsx). An unknown outcome is a held
  // slip whose verbs stand in the lane too; a changed chat, or the failed read after it, is the
  // lane's alone, and the holder rereads that read on focus and reconnection. Only the active pane
  // speaks a lane.
  const pending = state.command.kind === "Idle" ? null : state.command;
  const composed = pending?.command.kind === "Send" && pending.command.viewId === runtime.paneId;
  const holds = state.holder === runtime.paneId;
  const again = useCallback((openIntent: OpenIntent) => void paneStore.retryCommand(openIntent).then((outcome) => sayRefusal(slips, outcome)), [paneStore, slips]);
  useFailedReadRepair(holds && pending?.standing?.kind === "Unread", pending?.kind === "Busy", () => again("default"));
  useFailedReadRepair(history === "Unavailable" && !state.gone, state.readingTree, () => void store.load());

  usePaneReturnReady(savedOnly);
  if (state.defect) throw state.defect.error;
  if (savedOnly) {
    const absent = saved !== null ? null
      : catalogErrorFeedback(savedCatalog.data !== null ? { code: "E_CATALOG_COVERAGE" } : savedCatalog.error ?? { code: "E_CATALOG_UNAVAILABLE" });
    return <div className={styles.pane}>
      <div className={styles.lanes}>
        {saved === null ? null : <h1>{saved.title || "untitled chat"}</h1>}
        <Fact speak={isPaneActive} line={saved !== null ? { fact: "this chat’s messages aren’t saved on this device." }
          : absent !== null ? { fact: absent.title, reason: absent.message } : { fact: "couldn’t open saved chats." }} />
      </div>
    </div>;
  }

  const unknown = pending?.standing?.kind === "Unknown" && !composed ? pending : null;
  const unknownKey = unknown === null ? null : commandKey(unknown.command);
  const unknownRetry: CommandVerb | null = unknown && { label: "retry", commandKey: `retry ${unknownKey}`, busy: unknown.kind === "Busy", run: again };
  const unknownVerbs: Verbs | undefined = unknownRetry === null ? undefined : unknown?.command.kind === "Send"
    ? [unknownRetry, { label: "discard send", commandKey: `discard ${unknownKey}`, run: () => store.discardCommand() }]
    : [unknownRetry];
  const lane = pending?.standing?.kind === "Changed"
    ? <Fact speak={isPaneActive} line={changedLine(pending.command)}
      verbs={[{ label: "check", commandKey: `check ${commandKey(pending.command)}`, busy: pending.kind === "Busy", run: again }]} />
    : pending?.standing?.kind === "Unread"
      ? <Failed error={pending.standing.error} noun="messages" retry={{ run: again, busy: pending.kind === "Busy" }} />
      // the slip speaks the unknown outcome; the lane says why the pane waits, and carries its verbs
      : unknown !== null ? <Fact line={{ fact: PENDING_CHANGE }} verbs={unknownVerbs} />
      : null;
  return (
    <div className={styles.pane}>
      {unavailableBranch || intent.kind === "invalid" || lane !== null ? <div className={styles.lanes}>
        {unavailableBranch ? <Fact speak={isPaneActive} line={{ fact: "can’t find this branch." }}
          verbs={[{ label: "show forks", commandKey: "show forks", run: () => runtime.requestSecondarySurface("resource-forks") }]} /> : null}
        {intent.kind === "invalid" ? <Fact speak={isPaneActive} line={{ fact: "couldn’t attach this quote.", reason: "its link is broken." }} /> : null}
        {lane}
      </div> : null}
      {unknown && holds ? <Hold id={unknownKey!} attempt={unknown.attempt} line={{ fact: unsureFact(unknown.command), reason: MAY_HAVE }} verbs={unknownVerbs} /> : null}
      <ChatSurface
        ref={scroll}
        catalog={catalogRead}
        view={view}
        live={state.live}
        command={state.command}
        loading={loading}
        absent={loading ? <Ruling />
          : state.gone ? <Fact line={{ fact: "this chat doesn’t exist." }} />
          : history === "Unavailable" ? <Failed error={state.unread} noun="messages" retry={{ run: () => void store.load(), busy: state.readingTree }} />
          : null}
        store={paneStore}
        fork={fork}
        composer={
          <ChatComposer
            scope={conversationId ?? "new"}
            viewId={runtime.paneId}
            view={view}
            liveExecution={
              (view.activeRun && state.live[view.path.at(-1)!.id]?.execution) ??
              null
            }
            onClearBranch={() => setBranch(null)}
            quote={quote}
            onRemoveQuote={() => router.replace(pathOnly)}
            onRetryQuote={retryQuote}
            onRejected={(code) => {
              if (code === "E_READER_SELECTION_STALE") retryQuote();
              if (code === "E_CONVERSATION_NO_LONGER_EMPTY") void store.load();
            }}
            focusKey={focusKey ?? (quote ? `quote:${hash}` : null)}
            isPaneActive={isPaneActive}
          />
        }
      />
    </div>
  );
}
