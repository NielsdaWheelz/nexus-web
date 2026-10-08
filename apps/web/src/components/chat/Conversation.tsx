"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { FindResults } from "@/components/find/FindBar";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { parseReaderSelectionHash } from "@/lib/chat/readerIntent";
import { chatView, type BranchDraft } from "@/lib/chat/tree";
import type { AcceptedReceipt } from "@/lib/chat/wire";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { useFind } from "@/lib/find/useFind";
import {
  requirePaneRuntime,
  usePaneHash,
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { dispatchReaderSourceActivation } from "@/lib/resourceGraph/readerSourceActivation";
import type { ReaderSourceTarget } from "@/lib/resourceGraph/readerTarget";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import ChatComposer from "./ChatComposer";
import ChatSurface, {
  type ActivateSource,
  type RowActions,
} from "./ChatSurface";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useConversationFindSource } from "./conversationFind";
import { useChatStore } from "./conversationStore";
import { DocentOverlay, useDocentWalk } from "./Docent";
import { ForksPanel } from "./Forks";
import {
  readerTargetFromSelection,
  useQuotePreview,
} from "./QuotedPassageCard";
import type { ChatScrollHandle } from "./useChatScroll";
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
  const targetMessageId = params.get("message");
  const hash = usePaneHash();
  const intent = useMemo(() => parseReaderSelectionHash(hash), [hash]);
  const { quote, retry: retryQuote } = useQuotePreview(
    intent.kind === "key" ? intent.key : null,
  );
  const [branch, setBranch] = useState<BranchDraft | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const scroll = useRef<ChatScrollHandle | null>(null);
  const { messages, leafId, history, contextVersion } = state;
  const ready = history === "Ready";
  const view = useMemo(
    () => chatView({ messages, leafId, history }, conversationId, branch),
    [messages, leafId, history, conversationId, branch],
  );
  const docent = useDocentWalk(runtime.activateTarget);

  /** Open a cited or quoted source: pulse the reader, then route the pane. */
  const follow = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      disposition: WorkspaceTargetDisposition,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      return (
        runtime.resourceRef === activation.resource_ref ||
        activateResource(activation, {
          labelHint: target?.label,
          activateTarget: runtime.activateTarget,
          disposition,
        })
      );
    },
    [runtime],
  );
  const activate = useCallback<ActivateSource>(
    (activation, target, event) => {
      if (event?.defaultPrevented) return;
      const intent = event && workspaceTargetClickIntent(event);
      if (follow(activation, target, intent?.disposition ?? { kind: "Follow" }))
        event?.preventDefault();
    },
    [follow],
  );
  const actions = useMemo<RowActions>(
    () => ({
      store,
      activate,
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
    [store, activate, docent.start],
  );

  useEffect(() => {
    if (ready && targetMessageId) void store.reveal(targetMessageId);
  }, [ready, targetMessageId, store]);
  const find = useFind(
    useConversationFindSource({
      conversationId,
      activeLeafMessageId: leafId,
      messages: view.path,
      scroll,
    }),
  );
  const title =
    state.conversation?.title ?? (conversationId ? "Chat" : "New chat");
  useSetPaneLabel(history === "Loading" ? null : title);

  const bodies = useMemo(
    () => ({
      linkedItems: conversationId ? (
        <ConnectionsSurface resourceRef={{ scheme: "conversation", id: conversationId }} refreshKey={contextVersion} />
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
            if (receipt.conversationDeleted) router.replace("/conversations");
          }}
        />
      ),
    }),
    [conversationId, contextVersion, view, store, router],
  );
  const inspector = useResourceInspector({
    scheme: "conversation",
    handle: conversationId,
    bodies,
    searchResults: useMemo(() => find && <FindResults find={find} />, [find]),
    onCitationActivate: follow,
  });
  usePanePrimaryChrome({
    search: !conversationId
      ? undefined
      : history === "Loading"
        ? { kind: "Resolving", control: "Find" }
        : ready && find
          ? { kind: "Find", find }
          : undefined,
    companionAction: inspector.companionAction ?? undefined,
    actionSubject:
      conversationId && ready
        ? {
            ref: canonicalResourceRef({
              scheme: "conversation",
              id: conversationId,
            }),
          }
        : undefined,
  });

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
        targetMessageId={targetMessageId}
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
            onOpenQuote={(s) =>
              activate(s.activation, readerTargetFromSelection(s))
            }
            onAccepted={onAccepted}
            onRejected={(code) => {
              if (code === "E_READER_SELECTION_STALE") retryQuote();
              if (code === "E_CONVERSATION_NO_LONGER_EMPTY") void store.load();
            }}
            reloadRequestId={state.reloadRequestId}
            initialText={params.get("draft") ?? ""}
            focusKey={focusKey ?? (quote ? `quote:${hash}` : null)}
            isPaneActive={isPaneActive}
          />
        }
      />
    </div>
  );
}
