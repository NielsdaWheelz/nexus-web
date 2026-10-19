"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { readCatalog } from "@/lib/chat/catalog";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { parseReaderSelectionHash } from "@/lib/chat/readerIntent";
import { chatView, indexChildren, leafUnder, pathTo, type BranchDraft } from "@/lib/chat/tree";
import type { Catalog } from "@/lib/chat/wire";
import { conversationEndpoint, conversationViewHref, type ConversationEndpoint } from "@/lib/chat/view";
import type { CommandOutcome } from "@/lib/chat/commands";
import type { SendOutcome } from "@/lib/chat/drafts";
import { openAsyncResult } from "@/lib/panes/openResult";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { useFind } from "@/lib/find/useFind";
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
} from "@/lib/panes/paneRuntime";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import ChatComposer from "./ChatComposer";
import ChatSurface, { type RowActions } from "./ChatSurface";
import ChatContext from "./ChatContext";
import { useConversationFindSource } from "./conversationFind";
import { useChatStore } from "./conversationStore";
import { DocentOverlay, useDocentWalk } from "./Docent";
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

// Route state (id, ?message, ?draft, the quote hash) and the fork being
// composed live here; the store owns server state, the draft owns sending.
function Conversation({ conversationId }: { conversationId: string | null }) {
  const [state, store] = useChatStore(conversationId);
  const commandFailure = useRef<Exclude<typeof state.command, { kind: "Idle" }> | null>(null);
  if (state.command.kind === "Idle") commandFailure.current = null;
  else if (state.command.feedback || commandFailure.current?.command !== state.command.command)
    commandFailure.current = state.command;
  const catalogRead = useServerValue({
    key: "/llm-catalog",
    stale: "",
    visit: CATALOG_VISIT,
    load: readCatalog,
  });
  const runtime = requirePaneRuntime(usePaneRuntime(), "Conversation");
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
  const requested = useMemo(() => conversationEndpoint(params), [params]);
  const [endpoint, setEndpoint] = useState<{ visitId: string; value: ConversationEndpoint }>(
    () => ({ visitId: runtime.visitId, value: requested }),
  );
  const selected = requested.kind === "Unspecified"
    ? endpoint.value : requested;
  const leafId = selected.kind === "Endpoint" ? selected.messageId
    : selected.kind === "Unspecified" ? activeSendLeafId : null;
  const latestLeaf = useRef(leafId);
  latestLeaf.current = leafId;
  const unavailableBranch = selected.kind === "Invalid" || (ready && leafId !== null && !messages.has(leafId));
  const view = useMemo(
    () => chatView({ messages, leafId, history: unavailableBranch ? "Unavailable" : history }, conversationId, branch),
    [messages, leafId, history, unavailableBranch, conversationId, branch],
  );
  const docent = useDocentWalk(runtime.activateTarget);
  const previousMessages = useRef(messages);

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
        const current = latestRuntime.current;
        const endpoint = conversationEndpoint(new URL(current.href, "https://nexus.invalid").searchParams);
        let destinationLeaf = latestLeaf.current;
        if (!pathTo(store.getState().messages, destinationLeaf).some(item => item.id === message.id)) {
          if (endpoint.kind !== "Unspecified") return false;
          destinationLeaf = leafUnder(indexChildren(store.getState().messages.values()), message.id);
        }
        if (context.signal.aborted) return false;
        const href = new URL(current.href, "https://nexus.invalid");
        href.searchParams.set("leaf", destinationLeaf ?? "empty");
        if (!current.updatePaneViewHref({ visitId: current.visitId, href: `${href.pathname}${href.search}${href.hash}`, arrival: "preserve" })) return false;
        setEndpoint({ visitId: current.visitId, value: { kind: "Endpoint", messageId: destinationLeaf } });
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
  const selectEndpoint = useCallback((messageId: string | null) => {
    if (!conversationId) return;
    clearArrival();
    if (!runtime.updatePaneViewHref({ visitId: runtime.visitId,
      href: conversationViewHref(conversationId, messageId), arrival: "clear" })) return;
    setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId } });
    setBranch(null);
  }, [conversationId, runtime, clearArrival]);
  const landCommand = useCallback(async (run: () => Promise<CommandOutcome>, intent: OpenIntent = "default"): Promise<CommandOutcome> => {
    const originLeaf = leafId;
    let outcome: CommandOutcome = { kind: "Handled" };
    await openAsyncResult({ ctx, originPaneId: runtime.paneId, intent, disposition: "Adopt", subject: store.getState().conversation?.title,
      mayOpen: () => latestLeaf.current === originLeaf,
      create: async () => {
        outcome = await run();
        return outcome.kind === "Settled" && outcome.resultMessageId && conversationId ? {
          target: { href: conversationViewHref(conversationId, outcome.resultMessageId) },
          title: "response ready", openLabel: "open response",
        } : null;
      },
      onDefault: result => {
        const next = conversationEndpoint(new URL(result.target.href, "https://nexus.invalid").searchParams);
        if (next.kind === "Endpoint") selectEndpoint(next.messageId);
      },
    });
    return outcome;
  }, [ctx, runtime.paneId, leafId, conversationId, selectEndpoint, store]);
  const viewStore = useMemo(() => ({ ...store,
    repeat: (...args: Parameters<typeof store.repeat>) => landCommand(() => store.repeat(...args), args[3]),
    retryCommand: (intent: OpenIntent = "default") => {
      const state = store.getState().command;
      const frozen = state.kind !== "Idle" && (state.command.kind === "Send" || state.command.kind === "Repeat") ? state.command.openIntent : "default";
      return landCommand(() => store.retryCommand(intent), frozen === "new_pane" ? frozen : intent);
    },
    refreshCommand: (intent: OpenIntent = "default") => {
      const state = store.getState().command;
      const frozen = state.kind !== "Idle" && (state.command.kind === "Send" || state.command.kind === "Repeat") ? state.command.openIntent : "default";
      return landCommand(() => store.refreshCommand(intent), frozen === "new_pane" ? frozen : intent);
    },
  }), [store, landCommand]);
  const actions = useMemo<RowActions>(() => ({
    store: viewStore,
    walk: docent.start,
    fork: draft => {
      const command = store.getState().command;
      if (command.kind !== "Idle" && command.command.kind === "Send") return;
      setBranch(draft);
      setFocusKey(`${draft.parentId}:${Date.now()}`);
    },
    openLeaf: (leaf, anchorId) => {
      if (anchorId !== null) scroll.current?.keepAnchor(anchorId);
      selectEndpoint(leaf);
    },
  }), [viewStore, store, docent.start, selectEndpoint]);

  // A message verb from a resource menu (its href names ?message=), served
  // once the message is on the shown path; a deleted last message settles
  // the conversation's panes here.
  const { delivery, claim } = usePaneEntryDelivery();
  const feedback = useFeedback();
  const workspace = useLatestWorkspace();
  useEffect(() => {
    if (delivery === null || !("messageId" in delivery.entry) || !ready) return;
    const { entry } = delivery;
    const message = messages.get(entry.messageId);
    if (message && !view.path.some((m) => m.id === message.id)) {
      const messageLeaf = leafUnder(indexChildren(messages.values()), message.id);
      const href = new URL(runtime.href, "https://nexus.invalid");
      href.searchParams.set("leaf", messageLeaf);
      clearArrival();
      if (runtime.updatePaneViewHref({ visitId: runtime.visitId, href: `${href.pathname}${href.search}${href.hash}`, arrival: "preserve" }))
        setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId: messageLeaf } });
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
      actions.fork({
        parentId: message.id,
        anchor: { kind: "assistant_message", message_id: message.id },
        quote: "",
      });
    } else if (entry.kind === "WalkMessageSources") {
      if (message.citations.length >= 2) actions.walk(message);
    }
  }, [actions, clearArrival, claim, delivery, feedback, messages, ready, runtime, store, view.path, viewStore, workspace]);
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

  const bodies = useMemo(() => ({
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
          onOpen={(leaf, userId) => {
            selectEndpoint(leaf);
            requestAnimationFrame(() => scroll.current?.scrollToMessage(userId));
          }}
          onRename={store.renameFork}
          onDelete={store.deleteMessage}
        />
      ),
  }), [conversationId, contextVersion, view.children, view.pathIds, selectEndpoint, store]);
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
    if (endpoint.visitId !== runtime.visitId || requested.kind !== "Unspecified") {
      setEndpoint({ visitId: runtime.visitId, value });
    }
    if (!ready || !conversationId || requested.kind !== "Unspecified" || value.kind === "Invalid" || params.has("message")) return;
    const messageId = value.kind === "Endpoint" ? value.messageId : activeSendLeafId;
    const href = new URL(runtime.href, "https://nexus.invalid");
    href.searchParams.set("leaf", messageId ?? "empty");
    if (!runtime.updatePaneViewHref({ visitId: runtime.visitId, href: `${href.pathname}${href.search}${href.hash}`, arrival: "preserve" })) return;
    setEndpoint({ visitId: runtime.visitId, value: { kind: "Endpoint", messageId } });
    // A bare route retains this pane's endpoint, or seeds it once from the last send.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: explicit route or first ready tree owns endpoint initialization
  }, [runtime.visitId, requested, ready]);
  useEffect(() => {
    if (!ready) return;
    const previous = previousMessages.current;
    previousMessages.current = messages;
    if (!conversationId || leafId === null || messages.has(leafId) || !previous.has(leafId)) return;
    let ancestor = previous.get(leafId)?.parent_message_id ?? null;
    while (ancestor !== null && !messages.has(ancestor)) ancestor = previous.get(ancestor)?.parent_message_id ?? null;
    if (ancestor !== null) selectEndpoint(ancestor);
    feedback.receipt({ tone: "Neutral", title: "this branch was deleted" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: graph replacement repairs a known deleted endpoint once
  }, [messages, ready]);

  const pathOnly = conversationId ? conversationViewHref(conversationId, leafId) : "/conversations/new";
  const dispatchSend = async (run: () => Promise<SendOutcome>, openIntent: OpenIntent, subject: string): Promise<SendOutcome> => {
    const originLeaf = leafId;
    let outcome: SendOutcome = { kind: "Failed", failure: { kind: "Handled" } };
    await openAsyncResult({ ctx, originPaneId: runtime.paneId, intent: openIntent, disposition: "Adopt", subject: state.conversation?.title ?? subject,
      mayOpen: () => latestLeaf.current === originLeaf,
      create: async () => {
        outcome = await run();
        if (outcome.kind !== "Accepted") return null;
        return { target: { href: conversationViewHref(outcome.receipt.outcome.conversation_id, outcome.receipt.outcome.assistant_message_id) },
          title: "message sent", openLabel: "open response" };
      },
      onDefault: result => {
        if (conversationId === null) { router.replace(result.target.href, { activate: false }); return; }
        const next = conversationEndpoint(new URL(result.target.href, "https://nexus.invalid").searchParams);
        if (next.kind === "Endpoint") selectEndpoint(next.messageId);
      },
    });
    return outcome;
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
      {unavailableBranch ? <FeedbackNotice content={{ tone: "Warning", title: "this branch is no longer available" }} announcement="Polite" actions={[{ label: "choose another branch", onClick: () => runtime.requestSecondarySurface("resource-forks") }]} /> : null}
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
      {state.command.kind !== "Idle" && state.command.command.kind !== "DeleteChat" && commandFailure.current?.feedback ? (
        <FeedbackNotice
          content={commandFailure.current.feedback}
          announcement="Assertive"
          actions={[{ label: "check chat change", onClick: (intent) => void viewStore.retryCommand(intent),
            busy: state.command.kind === "Sending" || (state.command.kind === "Reconciling" && state.command.feedback === null),
          }]}
        />
      ) : null}
      <ChatSurface
        ref={scroll}
        catalog={catalogRead}
        view={view}
        live={state.live}
        command={state.command}
        loading={history === "Loading"}
        actions={actions}
        overlay={<DocentOverlay docent={docent} />}
        composer={
          <ChatComposer
            catalogRead={catalogRead}
            scope={conversationId ?? "new"}
            viewId={runtime.paneId}
            expectedRevision={state.conversation?.branch_revision ?? null}
            view={view}
            liveExecution={
              (view.activeRun && state.live[view.path.at(-1)!.id]?.execution) ??
              null
            }
            historyReady={ready}
            onClearBranch={() => setBranch(null)}
            onJumpToParent={(id) => scroll.current?.scrollToMessage(id)}
            onStop={store.cancel}
            quote={quote}
            onRemoveQuote={() => router.replace(pathOnly)}
            onRetryQuote={retryQuote}
            dispatchSend={dispatchSend}
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
