"use client";

/**
 * ChatFailureCard — the ONE chat-failure renderer.
 *
 * Operational cards share one compact structure:
 *   - `failure` mode: an `ExpectedChatFailure | null` folded onto the run (null
 *     is the generic DEFECT card). Copy comes exclusively from
 *     `chatFailureMessage`; the run-owned support occurrence is supplied
 *     independently, and the card shows AT MOST one action — `Rerun`, only
 *     when `canRerun`.
 *   - `reconnect` mode: the neutral CLIENT-ONLY recovery state owned by
 *     useChatRunTail.ts. It never calls /rerun; its single action resumes the
 *     same live tail from durable state.
 *   - `suspended` and `stop_requested` modes: server-derived execution facts.
 *     Neither promises that work stopped or offers a new-generation action.
 *
 * Invariant: the card renders AT MOST one action, never both.
 */

import Button from "@/components/ui/Button";
import type { Presence } from "@/lib/api/presence";
import { chatFailureMessage } from "@/lib/llm/failure";
import type { ExpectedChatFailure } from "@/lib/conversations/types";
import type { ChatConnectionRecovery } from "@/lib/conversations/chatConnectionRecovery";
import styles from "./ChatFailureCard.module.css";

interface FailureCardProps {
  mode?: "failure";
  failure: ExpectedChatFailure | null;
  supportId: Presence<string>;
  canRerun?: boolean;
  onRerun?: () => void;
  rerunning?: boolean;
}

interface ReconnectCardProps {
  mode: "reconnect";
  recovery: ChatConnectionRecovery;
  onReconnect: () => void;
}

interface SuspendedCardProps {
  mode: "suspended";
  cancelRequested: boolean;
}

interface StopRequestedCardProps {
  mode: "stop_requested";
}

type ChatFailureCardProps =
  | FailureCardProps
  | ReconnectCardProps
  | SuspendedCardProps
  | StopRequestedCardProps;

const SUSPENDED_COPY = {
  title: "Response paused",
  body: "The saved response needs repair. Its outcome is unconfirmed.",
};

const STOP_REQUESTED_COPY = {
  title: "Stop requested",
  body: "The response has not yet been confirmed stopped.",
};

function reconnectPresentation(recovery: ChatConnectionRecovery): {
  title: string;
  body: string;
  actionLabel: string;
  showAction: boolean;
  requestId?: string;
} {
  switch (recovery.kind) {
    case "Lost":
      return {
        title: "Connection lost",
        body: "We lost the connection to this response. Reconnect to pick up where it left off.",
        actionLabel: "Reconnect",
        showAction: true,
      };
    case "Reconnecting":
      return {
        title: "Reconnecting",
        body: "Checking the saved response and restoring its live connection.",
        actionLabel: "Reconnect",
        showAction: true,
      };
    case "Failed":
      return {
        title: "Couldn’t reconnect",
        body: recovery.message,
        actionLabel: "Try reconnecting",
        showAction: recovery.retryable,
        requestId: recovery.requestId,
      };
  }
}

export default function ChatFailureCard(props: ChatFailureCardProps) {
  if (props.mode === "suspended") {
    return (
      <div className={`${styles.card} ${styles.reconnect}`} role="status">
        <p className={styles.title}>
          {props.cancelRequested ? STOP_REQUESTED_COPY.title : SUSPENDED_COPY.title}
        </p>
        <p className={styles.body}>
          {props.cancelRequested
            ? "The outcome is unconfirmed. The saved response needs repair."
            : SUSPENDED_COPY.body}
        </p>
      </div>
    );
  }

  if (props.mode === "stop_requested") {
    return (
      <div className={`${styles.card} ${styles.reconnect}`} role="status">
        <p className={styles.title}>{STOP_REQUESTED_COPY.title}</p>
        <p className={styles.body}>{STOP_REQUESTED_COPY.body}</p>
      </div>
    );
  }

  if (props.mode === "reconnect") {
    const reconnecting = props.recovery.kind === "Reconnecting";
    const presentation = reconnectPresentation(props.recovery);
    return (
      <div className={`${styles.card} ${styles.reconnect}`} role="alert">
        <p className={styles.title}>{presentation.title}</p>
        <p className={styles.body}>{presentation.body}</p>
        {presentation.requestId ? (
          <p className={styles.supportId}>
            Request ID: {presentation.requestId}
          </p>
        ) : null}
        {presentation.showAction ? (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              loading={reconnecting}
              onClick={props.onReconnect}
            >
              {presentation.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const { failure, supportId, canRerun, onRerun, rerunning } = props;
  const { title, body } = chatFailureMessage(failure);
  const showRerun = Boolean(canRerun && onRerun);

  return (
    <div className={styles.card} role="alert">
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{body}</p>
      {supportId.kind === "Present" ? (
        <p className={styles.supportId}>Support ID: {supportId.value}</p>
      ) : null}
      {showRerun ? (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            loading={rerunning}
            onClick={onRerun}
          >
            Rerun
          </Button>
        </div>
      ) : null}
    </div>
  );
}
