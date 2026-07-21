"use client";

/**
 * ChatFailureCard — the ONE chat-failure renderer.
 *
 * Two shapes share one quiet, red-bordered card:
 *   - `failure` mode: an `ExpectedChatFailure | null` folded onto the run (null
 *     is the generic DEFECT card). Copy comes exclusively from
 *     `chatFailureMessage`; it shows an optional support id and AT MOST one
 *     action — `Run again`, only when `canRerun`.
 *   - `reconnect` mode: the CLIENT-ONLY `ConnectionLostStatusUnknown` state owned
 *     by useChatRunTail.ts. It never calls /rerun; its single action is
 *     `Reconnect`, which resumes the live tail from the last cursor.
 *
 * Invariant: the card renders AT MOST one action, never both.
 */

import Button from "@/components/ui/Button";
import { chatFailureMessage } from "@/lib/llm/failure";
import type { ExpectedChatFailure } from "@/lib/conversations/types";
import styles from "./ChatFailureCard.module.css";

interface FailureCardProps {
  mode?: "failure";
  failure: ExpectedChatFailure | null;
  canRerun?: boolean;
  onRerun?: () => void;
  rerunning?: boolean;
}

interface ReconnectCardProps {
  mode: "reconnect";
  onReconnect: () => void;
}

type ChatFailureCardProps = FailureCardProps | ReconnectCardProps;

const RECONNECT_COPY = {
  title: "Connection lost",
  body: "We lost the connection to this response. Reconnect to pick up where it left off.",
};

export default function ChatFailureCard(props: ChatFailureCardProps) {
  if (props.mode === "reconnect") {
    return (
      <div className={styles.card} role="alert">
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

  const { failure, canRerun, onRerun, rerunning } = props;
  const { title, body } = chatFailureMessage(failure);
  const supportId = failure?.support_id ?? null;
  const showRerun = Boolean(canRerun && onRerun);

  return (
    <div className={styles.card} role="alert">
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{body}</p>
      {supportId ? (
        <p className={styles.supportId}>Support ID: {supportId}</p>
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
