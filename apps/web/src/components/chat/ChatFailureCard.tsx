"use client";

/**
 * ChatFailureCard — the ONE chat-failure renderer.
 *
 * Three operational cards share one compact structure:
 *   - `failure` mode: an `ExpectedChatFailure | null` folded onto the run (null
 *     is the generic DEFECT card). Copy comes exclusively from
 *     `chatFailureMessage`; the run-owned support occurrence is supplied
 *     independently, and the card shows AT MOST one action — `Rerun`, only
 *     when `canRerun`.
 *   - `reconnect` mode: the neutral CLIENT-ONLY recovery state owned by
 *     useChatRunTail.ts. It never calls /rerun; its single action resumes the
 *     same live tail from durable state.
 *   - `suspended` mode: the server-derived durable execution advisory. It has
 *     fixed copy and no action; continuing this same run is an operator repair,
 *     not a user rerun or a network reconnect.
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
  stopRequested: boolean;
  onCheckStatus?: () => void;
  checking: boolean;
}

type ChatFailureCardProps =
  | FailureCardProps
  | ReconnectCardProps
  | SuspendedCardProps;

const SUSPENDED_COPY = {
  title: "Response paused",
  body: "This response is paused. Its outcome is unconfirmed.",
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
        body: "Reconnect to check this run's saved status and listen for later updates.",
        actionLabel: "Reconnect",
        showAction: true,
      };
    case "Reconnecting":
      return {
        title: "Reconnecting",
        body: "Checking this run's saved status and restoring its live connection.",
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
      <div className={styles.card} role="status" aria-live="polite">
        <p className={styles.title}>{props.stopRequested ? "Stop requested" : SUSPENDED_COPY.title}</p>
        <p className={styles.body}>{props.stopRequested ? "The outcome is unconfirmed." : SUSPENDED_COPY.body}</p>
        {props.onCheckStatus ? (
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" loading={props.checking} onClick={props.onCheckStatus}>
              Check saved status
            </Button>
          </div>
        ) : null}
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
