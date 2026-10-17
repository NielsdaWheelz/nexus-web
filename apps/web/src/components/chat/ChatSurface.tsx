"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowDown, ChevronDown, ChevronRight } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import type { ServerValue } from "@/lib/api/serverState";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import type { Live } from "@/lib/chat/runTail";
import { alternatives, type Alternative, type BranchDraft, type ChatView } from "@/lib/chat/tree";
import type { Catalog, Message } from "@/lib/chat/wire";
import AssistantMessage from "./AssistantMessage";
import type { ChatState, ChatStore } from "./conversationStore";
import { AlternativeSelector } from "./Forks";
import MessageFooter from "./MessageFooter";
import MessageDialogs, { type MessageDialogRequest } from "./MessageDialogs";
import QuotedPassage from "./QuotedPassage";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";
import footerStyles from "./MessageFooter.module.css";

export type RowActions = Readonly<{
  store: ChatStore;
  fork(draft: BranchDraft): void;
  walk(message: Message): void;
  openLeaf(leafId: string, anchorId: string | null): Promise<CommandOutcome>;
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
    actions: RowActions;
    composer: ReactNode;
    overlay: ReactNode;
  }
>(function ChatSurface(
  { view, live, command, catalog, loading, actions, composer, overlay },
  ref,
) {
  const scrollport = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastUserId =
    view.path.findLast((message) => message.role === "user")?.id ?? null;
  const scroll = useChatScroll(scrollport, transcript, lastUserId, view.path.at(-1)?.id ?? null, !loading);
  useImperativeHandle(ref, () => scroll.handle, [scroll.handle]);
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
        onFocus={scroll.onFocus}
        onWheel={scroll.onUserScroll}
        onTouchMove={scroll.onUserScroll}
        onKeyDown={scroll.onKeyDown}
        onPointerDown={scroll.onPointerDown}
        onClick={scroll.onClick}
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
                onInspect={scroll.handle.inspectDisclosure}
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
        store={actions.store} region={scrollport} onClose={closeDialog} />
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
  actions, onInspect,
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
  onInspect(trigger: HTMLElement): void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const footer = (currentAction: string | null, status: string | null) =>
    <MessageFooter message={message} latest={latest} command={command} engaged={engaged}
      detailsOpen={detailsOpen} currentAction={currentAction} status={status}
      details={message.role === "assistant" ? <button ref={detailsTrigger} type="button" className={footerStyles.control}
        aria-expanded={detailsOpen} aria-controls={detailsId}
        onClick={(event) => {
          onInspect(event.currentTarget);
          if (detailsOpen && document.getElementById(detailsId)?.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
          setDetailsOpen(!detailsOpen);
        }}>details{detailsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button> : null}
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
        detailsId={detailsId}
        detailsOpen={detailsOpen}
        detailsTrigger={detailsTrigger}
        onInspect={onInspect}
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
          <QuotedPassage
            quote={{ kind: "Sent", selection: quote }}
            occurrenceKey={`quote:${message.id}`}
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
      {footer(null, null)}
    </div>
  );
});
