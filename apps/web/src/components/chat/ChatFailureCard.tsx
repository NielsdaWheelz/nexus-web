"use client";

/**
 * ChatFailureCard — the ONE chat-failure renderer.
 *
 * Three operational cards share one compact structure:
 *   - `failure` mode: an `ExpectedChatFailure | null` folded onto the run (null
 *     is the generic DEFECT card). Copy comes exclusively from
 *     `chatFailureMessage`; the run-owned support occurrence is supplied
 *     independently, and the card shows AT MOST one action — `Run again`, only
 *     when `canRerun`.
 *   - `reconnect` mode: the neutral CLIENT-ONLY
 *     `ConnectionLostStatusUnknown` state owned
 *     by useChatRunTail.ts. It never calls /rerun; its single action is
 *     `Reconnect`, which resumes the live tail from the last cursor.
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
  onReconnect: () => void;
}

interface SuspendedCardProps {
  mode: "suspended";
}

type ChatFailureCardProps =
  | FailureCardProps
  | ReconnectCardProps
  | SuspendedCardProps;

const RECONNECT_COPY = {
  title: "Connection lost",
  body: "We lost the connection to this response. Reconnect to pick up where it left off.",
};

const SUSPENDED_COPY = {
  title: "Response paused",
  body: "Nexus saved the completed work but could not safely continue.",
};

export default function ChatFailureCard(props: ChatFailureCardProps) {
  if (props.mode === "suspended") {
    return (
      <div className={styles.card} role="alert">
        <p className={styles.title}>{SUSPENDED_COPY.title}</p>
        <p className={styles.body}>{SUSPENDED_COPY.body}</p>
      </div>
    );
  }

  if (props.mode === "reconnect") {
    return (
      <div className={`${styles.card} ${styles.reconnect}`} role="alert">
        <p className={styles.title}>{RECONNECT_COPY.title}</p>
        <p className={styles.body}>{RECONNECT_COPY.body}</p>
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={props.onReconnect}>
            Reconnect
          </Button>
        </div>
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
            Run again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
