"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { readCatalog } from "@/lib/chat/catalog";
import { recoveryOf, type CommandOutcome } from "@/lib/chat/commands";
import { parseReaderSelectionHash } from "@/lib/chat/readerIntent";
import { chatView, indexChildren, leafUnder, pathTo, type BranchDraft } from "@/lib/chat/tree";
import { conversationEndpoint, conversationViewHref, type ConversationEndpoint } from "@/lib/chat/view";
import type { Catalog } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
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
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import ChatComposer from "./ChatComposer";
import ChatSurface from "./ChatSurface";
import ChatContext from "./ChatContext";
import { useConversationFindSource } from "./conversationFind";
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

// Route state (id, ?leaf, ?message, ?draft, the quote hash), the pane's endpoint and
// the fork being composed live here; the store owns server state, the command owner
// owns writes, the pane lands their answers.
function Conversation({ conversationId }: { conversationId: string | null }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "Conversation");
  const [state, store] = useChatStore(conversationId, runtime.paneId);
  // A menu's chat deletion speaks as a workspace condition (commandFeedback.tsx).
  const recovery = recoveryOf(state.command, (command) => command.kind !== "DeleteChat");
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

  const fork = useCallback((draft: BranchDraft) => {
    const command = store.getState().command;
    if (command.kind !== "Idle" && command.command.kind === "Send") return;
    setBranch(draft);
    setFocusKey(`${draft.parentId}:${Date.now()}`);
  }, [store]);

  const arrival = useSourceArrival({
    ready,
    sourceIdentity: conversationId,
    apply: async (arrivalTarget, context) => {
      if (arrivalTarget.kind !== "source") return false;
      const result = arrivalTarget.source;
      setInvalidatedInspection(false);
      if (result.location.kind === "resource") {
        if (context.mayFocus()) {
          const transcript = scroll.current?.getTranscriptElement();
          if (transcript) { transcript.tabIndex = -1; transcript.focus({ preventScroll: true }); }
        }
        return true;
      }
      if (result.location.kind !== "located" || result.location.locator.type !== "message_offsets") return false;
      const locator = result.location.locator;
      const message = store.getState().messages.get(locator.message_id);
      if (!message || locator.conversation_id !== conversationId || context.signal.aborted) return false;
      if (locator.start_offset !== 0 || locator.end_offset !== Array.from(message.content).length) return false;
      const exact = message.content;
      if (locator.text_quote_selector?.exact !== exact) return false;
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
          if (conversationEndpoint(new URL(current.href, "https://nexus.invalid").searchParams).kind !== "Unspecified") return false;
          destination = leafUnder(indexChildren(store.getState().messages.values()), message.id);
        }
        if (context.signal.aborted || !persistEndpoint(current, destination)) return false;
        setEndpoint({ visitId: current.visitId, value: { kind: "Endpoint", messageId: destination } });
        if (!stillCurrent() || context.signal.aborted) retire();
        const applied = !inspection.signal.aborted && await inspectChatMessage(scroll.current, message.id, { ...context, signal: inspection.signal });
        if (!applied) retire();
        return applied;
      } catch (error) {
        retire();
        throw error;
      }
    },
  });

  const clearArrival = arrival.clear;
  /** Show `messageId`'s path in this pane: no write, only the pane's visit href. */
  const selectEndpoint = useCallback((messageId: string | null) => {
    if (!conversationId) return;
    clearArrival();
    if (!runtime.updatePaneViewHref({ visitId: runtime.visitId, href: conversationViewHref(conversationId, messageId), arrival: "clear" })) return;
    setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId } });
    setBranch(null);
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
            title: sending === null ? "response ready" : "message sent",
            openLabel: "open response",
          };
        },
        onDefault: (result) => {
          if (conversationId === null) return router.replace(result.target.href, { activate: false });
          const next = conversationEndpoint(new URL(result.target.href, "https://nexus.invalid").searchParams);
          if (next.kind === "Endpoint") selectEndpoint(next.messageId);
        },
      });
      return outcome;
    };
    return {
      ...store,
      send: (request, openIntent, onAcceptance) =>
        land(() => store.send(request, openIntent, onAcceptance), openIntent, truncateText(request.content, 220)),
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

  // Message edits are delivered to a mounted pane once their target is on its
  // path; a source walk starts in the action owner without a preparatory pane.
  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
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
    if (!message)
      return void feedback.offer({ key: "conversation-action", announcement: "Polite", content: { tone: "Neutral", title: "This message is no longer available." } });
    if (entry.kind === "DeleteMessage") {
      void store.deleteMessage(message.id);
    } else if (message.role !== "assistant") {
      return;
    } else if (entry.kind === "ForkMessage") {
      fork({
        parentId: message.id,
        anchor: { kind: "assistant_message", message_id: message.id },
        quote: "",
      });
    }
  }, [fork, clearArrival, claim, delivery, feedback, messages, ready, runtime, store, view.path]);
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
  });
  const find = useFind({ ownerKey, source: findSource });

  const bodies = useMemo(
    () => ({
      linkedItems: conversationId ? (
        <ChatContext conversationId={conversationId} refreshKey={contextVersion} />
      ) : (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Start a chat to link items." }}
          announcement="None"
        />
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
    handle: conversationId,
    bodies,
  });
  // streaming re-renders this body often; publish only what changed.
  const loading = history === "Loading";
  usePaneChrome(
    useMemo(
      () => ({
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
      [conversationId, find, loading, ready],
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
    if (!conversationId || leafId === null || messages.has(leafId) || !previous.has(leafId)) return;
    // the shown branch was deleted: fall back to its nearest surviving ancestor, never another branch
    let ancestor = previous.get(leafId)?.parent_message_id ?? null;
    while (ancestor !== null && !messages.has(ancestor)) ancestor = previous.get(ancestor)?.parent_message_id ?? null;
    if (ancestor !== null) selectEndpoint(ancestor);
    feedback.receipt({ tone: "Neutral", title: "this branch was deleted" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: a replaced graph repairs a known deleted endpoint once
  }, [messages, ready]);

  const pathOnly = conversationId ? conversationViewHref(conversationId, leafId) : "/conversations/new";
  const check = {
    label: "check chat change",
    onClick: (openIntent: OpenIntent) => void paneStore.retryCommand(openIntent),
    busy: recovery?.kind === "Busy",
  };

  if (state.defect) throw state.defect.error;
  if (history === "Unavailable" && messages.size === 0)
    return (
      <FeedbackNotice
        content={
          state.error ?? {
            tone: "Danger",
            title: "This chat couldn’t be opened.",
          }
        }
        announcement="Assertive"
      />
    );
  return (
    <div className={styles.pane}>
      {unavailableBranch ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "this branch is no longer available" }}
          announcement="Polite"
          actions={[{ label: "choose another branch", onClick: () => runtime.requestSecondarySurface("resource-forks") }]}
        />
      ) : null}
      {intent.kind === "invalid" ? (
        <FeedbackNotice
          content={{
            tone: "Danger",
            title: "This quote link is malformed",
            message:
              "The passage couldn’t be attached. Reopen it from the reader.",
          }}
          announcement="Assertive"
        />
      ) : null}
      {arrival.failure || invalidatedInspection ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure ?? "quoted location unavailable" }} announcement="Polite" /> : null}
      {state.error ? (
        <FeedbackNotice
          content={state.error}
          announcement="Assertive"
          actions={[{ label: "Dismiss", onClick: store.dismissError }]}
        />
      ) : null}
      {recovery?.feedback ? (
        <FeedbackNotice
          content={recovery.feedback}
          announcement="Assertive"
          actions={recovery.kind === "Unconfirmed" && recovery.command.kind === "Send"
            // the viewer's way out of a send no retry settles; the draft keeps its text
            ? [check, { label: "discard send", onClick: store.discardCommand }]
            : [check]}
        />
      ) : null}
      <ChatSurface
        ref={scroll}
        catalog={catalogRead}
        view={view}
        live={state.live}
        command={state.command}
        loading={history === "Loading"}
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
            historyReady={ready}
            onClearBranch={() => setBranch(null)}
            quote={quote}
            onRemoveQuote={() => router.replace(pathOnly)}
            onRetryQuote={retryQuote}
            onRejected={(code) => {
              if (code === "E_READER_SELECTION_STALE") retryQuote();
              if (code === "E_CONVERSATION_NO_LONGER_EMPTY") void store.load();
            }}
            initialText={params.get("draft") ?? ""}
            focusKey={focusKey ?? (quote ? `quote:${hash}` : null)}
            isPaneActive={isPaneActive}
          />
        }
      />
    </div>
  );
}
