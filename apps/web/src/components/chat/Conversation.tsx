"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { parseReaderSelectionHash } from "@/lib/chat/readerIntent";
import { chatView, type BranchDraft } from "@/lib/chat/tree";
import type { AcceptedReceipt } from "@/lib/chat/wire";
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
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useLatestWorkspace } from "@/lib/workspace/store";
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

/** The conversation pane. A changed route id mounts a fresh conversation. */
export default function ConversationPane() {
  const id = usePaneParam("id");
  return <Conversation key={id ?? "new"} conversationId={id} />;
}

// Route state (id, ?message, ?draft, the quote hash) and the fork being
// composed live here; the store owns server state, the draft owns sending.
function Conversation({ conversationId }: { conversationId: string | null }) {
  const [state, store] = useChatStore(conversationId);
  const runtime = requirePaneRuntime(usePaneRuntime(), "Conversation");
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
  const { messages, leafId, history, contextVersion } = state;
  const ready = history === "Ready";
  const view = useMemo(
    () => chatView({ messages, leafId, history }, conversationId, branch),
    [messages, leafId, history, conversationId, branch],
  );
  const docent = useDocentWalk(runtime.activateTarget);

  const actions = useMemo<RowActions>(
    () => ({
      store,
      walk: docent.start,
      fork: (draft) => {
        setBranch(draft);
        setFocusKey(`${draft.parentId}:${Date.now()}`);
      },
      openLeaf: (leaf, anchorId) => {
        scroll.current?.keepAnchor(anchorId);
        void store.switchTo(leaf);
      },
    }),
    [store, docent.start],
  );

  const arrival = useSourceArrival({
    ready,
    sourceIdentity: conversationId,
    apply: async (result, context) => {
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
        await store.reveal(message.id);
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
      void store.reveal(message.id);
      return;
    }
    if (!claim(delivery)) return;
    if (!message)
      return feedback.publish({
        kind: "Hud",
        content: { tone: "Neutral", title: "This message is no longer available." },
      });
    if (entry.kind === "DeleteMessage") {
      void store.deleteMessage(message.id).then((receipt) => {
        if (!receipt.conversation_deleted) return;
        settleDeletedResourcePanes({
          workspace: workspace(),
          deletedRef: `conversation:${receipt.conversation_id}`,
          fallbackHref: "/conversations",
        });
      }, () => undefined); // the store reported the failure
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
    } else {
      void store.repeat(entry.kind === "RerunMessage" ? "rerun" : "regenerate", message.id);
    }
  }, [actions, claim, delivery, feedback, messages, ready, store, view.path, workspace]);
  const ownerKey = paneSourceKey(runtime);
  const findSource = useConversationFindSource({
    ownerKey,
    conversationId,
    activeLeafMessageId: leafId,
    messages: view.path,
    scroll,
  });
  const find = useFind({ ownerKey, source: findSource });
  const title =
    state.conversation?.title ?? (conversationId ? "Chat" : "New chat");
  useSetPaneLabel(history === "Loading" ? null : title);

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
          onOpen={async (leaf, userId) => {
            await store.switchTo(leaf);
            scroll.current?.scrollToMessage(userId);
          }}
          onRename={store.renameFork}
          onDelete={async (userId) => {
            const receipt = await store.deleteMessage(userId);
            if (receipt.conversation_deleted) router.replace("/conversations");
          }}
        />
      ),
    }),
    [conversationId, contextVersion, view, store, router],
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

  const pathOnly = `/conversations/${conversationId ?? "new"}`;
  const onAccepted = (receipt: AcceptedReceipt) => {
    setBranch(null);
    const { conversation_id, assistant_message_id } = receipt.outcome;
    if (conversationId === null) {
      const href = `/conversations/${conversation_id}?message=${assistant_message_id}`;
      return router.replace(href, { activate: false });
    }
    if (intent.kind !== "none") router.replace(pathOnly); // the quote is spent
    void store.adopt(receipt);
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
      {arrival.failure || invalidatedInspection ? <p role="status">{arrival.failure ?? "quoted location unavailable"}</p> : null}
      {state.error ? (
        <FeedbackNotice
          content={state.error}
          announcement="Assertive"
          actions={[{ label: "Dismiss", onClick: store.dismissError }]}
        />
      ) : null}
      <ChatSurface
        ref={scroll}
        view={view}
        live={state.live}
        busy={state.busy}
        loading={history === "Loading"}
        actions={actions}
        overlay={<DocentOverlay docent={docent} />}
        composer={
          <ChatComposer
            scope={conversationId ?? "new"}
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
            onAccepted={onAccepted}
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
