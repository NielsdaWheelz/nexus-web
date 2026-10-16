"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowDown } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type { ServerValue } from "@/lib/api/serverState";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import type { Live } from "@/lib/chat/runTail";
import { alternatives, type Alternative, type BranchDraft, type ChatView } from "@/lib/chat/tree";
import type { Catalog, Message } from "@/lib/chat/wire";
import type { ReaderSourceTarget } from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
import AssistantMessage from "./AssistantMessage";
import type { ChatState, ChatStore } from "./conversationStore";
import { AlternativeSelector } from "./Forks";
import MessageFooter from "./MessageFooter";
import MessageDialogs, { type MessageDialogRequest } from "./MessageDialogs";
import QuotedPassageCard, {
  readerTargetFromSelection,
} from "./QuotedPassageCard";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

export type ActivateSource = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  event?: React.MouseEvent,
) => void;
export type RowActions = Readonly<{
  store: ChatStore;
  fork(draft: BranchDraft): void;
  walk(message: Message): void;
  openLeaf(leafId: string, anchorId: string | null): Promise<CommandOutcome>;
  activate: ActivateSource;
}>;

const NO_ALTERNATIVES: readonly Alternative[] = [];

/** The active transcript, its local disclosures, and the docked composer. */
const ChatSurface = forwardRef<
  ChatScrollHandle,
  {
    view: ChatView;
    live: ChatState["live"];
    command: CommandState;
    catalog: ServerValue<Catalog>;
    loading: boolean;
    targetMessageId: string | null;
    actions: RowActions;
    composer: ReactNode;
    overlay: ReactNode;
  }
>(function ChatSurface(
  { view, live, command, catalog, loading, targetMessageId, actions, composer, overlay },
  ref,
) {
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastUserId =
    view.path.findLast((message) => message.role === "user")?.id ?? null;
  const scroll = useChatScroll(scrollport, transcript, lastUserId, !loading);
  useImperativeHandle(ref, () => scroll.handle, [scroll.handle]);
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!targetMessageId || loading || revealed.current === targetMessageId)
      return;
    if (!view.pathIds.has(targetMessageId)) return;
    revealed.current = targetMessageId;
    scroll.handle.scrollToMessage(targetMessageId);
  }, [targetMessageId, loading, view.pathIds, scroll.handle]);
  const [dialog, setDialog] = useState<MessageDialogRequest | null>(null);
  const openDialog = useCallback((request: MessageDialogRequest) => setDialog(request), []);
  const closeDialog = useCallback((request: MessageDialogRequest) => setDialog((current) => current === request ? null : current), []);
  const regenerate = useCallback((id: string) => actions.store.repeat("regenerate", id), [actions.store]);
  const [rootReveal, setRootReveal] = useState<string | null>(null);
  const revealRoot = useCallback((id: string) => setRootReveal(id), []);
  useLayoutEffect(() => {
    if (!rootReveal || !view.pathIds.has(rootReveal)) return;
    const frame = requestAnimationFrame(() => {
      scrollport.current?.focus({ preventScroll: true });
      scroll.handle.scrollToMessage(rootReveal);
      setRootReveal(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [rootReveal, view.pathIds, scroll.handle]);
  const siblings = useMemo(() => {
    const groups = new Map<string | null, readonly Alternative[]>();
    groups.set(null, alternatives(view.children, null, view.pathIds));
    for (const message of view.path) if (message.role === "assistant")
      groups.set(message.id, alternatives(view.children, message.id, view.pathIds));
    return groups;
  }, [view]);
  const roots = siblings.get(null) ?? NO_ALTERNATIVES;
  const latestSettledId = view.path.findLast((message) => message.role === "assistant" && message.status !== "pending")?.id ?? null;

  return (
    <div className={styles.surface}>
      <div
        ref={scrollport}
        className={styles.scrollport}
        role="region"
        tabIndex={0}
        aria-label="Chat conversation"
        onScroll={scroll.onScroll}
        onWheel={scroll.onUserScroll}
        onTouchMove={scroll.onUserScroll}
        onKeyDown={scroll.onUserScroll}
      >
        <div
          ref={transcript}
          className={styles.transcript}
          role="log"
          aria-label="Chat messages"
        >
          {loading && view.path.length === 0 ? (
            <FeedbackNotice
              content={{ tone: "Info", title: "Loading conversation..." }}
              announcement="None"
            />
          ) : null}
          {roots.length ? <div className={styles.rootAlternatives}><AlternativeSelector options={roots} parentId={null}
            command={command} onOpen={actions.openLeaf} onRootSelected={revealRoot} region={scrollport}
            retryCommand={actions.store.retryCommand} refreshCommand={actions.store.refreshCommand} /></div> : null}
          {view.path.map((message, index) => (
              <Row
                key={message.id}
                message={message}
                ordinal={index + 1}
                live={live[message.id] ?? null}
                command={command}
                latest={message.id === latestSettledId}
                siblings={siblings.get(message.id) ?? NO_ALTERNATIVES}
                engaged={dialog?.messageId === message.id}
                onDialog={openDialog}
                onRegenerate={regenerate}
                onRootSelected={revealRoot}
                region={scrollport}
                actions={actions}
              />
          ))}
          <div
            className={styles.spacer}
            aria-hidden="true"
            style={{ height: scroll.spacer }}
          />
        </div>
        {scroll.latestBelow ? (
          <div className={styles.latest}>
            <Button
              variant="pill"
              size="sm"
              leadingIcon={<ArrowDown size={14} aria-hidden="true" />}
              onClick={scroll.toLatest}
            >
              Latest
            </Button>
          </div>
        ) : null}
      </div>
      <div className={styles.composerSlot} onWheel={scroll.onComposerWheel}>
        {overlay}
        {composer}
      </div>
      <MessageDialogs request={dialog} messages={view.messages} command={command} catalog={catalog}
        store={actions.store} activate={actions.activate} region={scrollport} onClose={closeDialog} />
    </div>
  );
});
export default ChatSurface;

/** One message and its resource menu. */
const Row = memo(function Row({
  message,
  ordinal,
  live,
  command, latest, siblings, engaged, onDialog, onRegenerate, onRootSelected, region,
  actions,
}: {
  message: Message;
  ordinal: number;
  live: Live | null;
  command: CommandState;
  latest: boolean;
  siblings: readonly Alternative[];
  engaged: boolean;
  onDialog(request: MessageDialogRequest): void;
  onRegenerate(id: string): Promise<CommandOutcome>;
  onRootSelected(userId: string): void;
  region: RefObject<HTMLDivElement | null>;
  actions: RowActions;
}) {
  const footer = message.role === "assistant" && message.status === "pending" ? null :
    <MessageFooter message={message} latest={latest} command={command} engaged={engaged}
      onDialog={onDialog} onRegenerate={onRegenerate}
      alternatives={siblings.length ? <AlternativeSelector options={siblings} parentId={message.id}
        command={command} onOpen={actions.openLeaf} onRootSelected={onRootSelected} region={region}
        retryCommand={actions.store.retryCommand} refreshCommand={actions.store.refreshCommand} /> : null} />;
  if (message.role === "assistant")
    return (
      <AssistantMessage
        message={message}
        ordinal={ordinal}
        live={live}
        command={command}
        footer={footer}
        actions={actions}
      />
    );
  const quote = message.reader_selection;
  return (
    <div
      className={styles.message}
      data-message-id={message.id}
      data-role="user"
      role="group"
      aria-label="Your message"
    >
      <div className={styles.userPrompt}>
        {quote ? (
          <QuotedPassageCard
            quote={{ kind: "Sent", selection: quote }}
            onOpen={(s) =>
              actions.activate(s.activation, readerTargetFromSelection(s))
            }
          />
        ) : null}
        <span
          className={styles.userBody}
          data-pane-find-block="true"
          data-pane-find-message-ordinal={ordinal}
          data-pane-find-role="user"
        >
          {message.content}
        </span>
      </div>
      {footer}
    </div>
  );
});
